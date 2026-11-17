# Frond Templates (Server-Rendered UI)

This reference covers **server-side Frond templates** — the monolithic, server-rendered path. The
reactive browser frontend (tina4-js signals/components) and the `frond.js` browser helper belong to
the **tina4-js** skill, not here.

Templates live in `src/templates/` as `*.twig` or `*.html.twig` files.

## Rendering

`response.render` is **async in Node — always `await` it**:

```typescript
// src/routes/get.ts   →  GET /
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { User } from "../models/User.js";

export default async function (request: Tina4Request, response: Tina4Response) {
  return await response.render("index.twig", {
    title: "My App",
    users: await User.all(),
  });
}
```

Need the rendered HTML as a string (for an email body, etc.) rather than a response? Import the Frond
engine from `tina4-nodejs/frond`.

## Globals (values available in every template)

Register a global with the static form, at boot (in `app.ts`, before `startServer()`):

```typescript
import { Frond } from "tina4-nodejs/frond";
Frond.addGlobal("app_name", "My App");   // class registry — every engine built afterwards gets it
```

```twig
<title>{{ app_name }}</title>
```

Do not register on a throwaway `new Frond()` — that instance is discarded and no page ever sees the
global. The static registry is copied into each engine **when the engine is constructed**
(ADR-0052); `res.render()` builds its engine lazily on the first render, so register at boot.

**A zero-argument function global is called for you (ADR-0085).** `{% if flag %}` and `{{ flag }}`
invoke `flag()` and use its RETURN value:

```typescript
Frond.addGlobal("admin_only", () => access.adminOnly());
```

```twig
{% if admin_only %} ...admin link... {% endif %}   {# calls admin_only() — uses its boolean result #}
```

Verified on tina4-nodejs 3.13.x with `addGlobal("g", () => false)`: `{% if g %}`
is **false**, `{{ g }}` prints `false`, and `() => true` makes `{% if g %}` true. PHP, Python and
Ruby do the same for a zero-argument closure (ADR-0085). Consequences:

- A boolean flag registered as a zero-arg function **just works** in `{% if flag %}`.
- The function is called with **no arguments** every time it is named, so a global
  that needs arguments must be called explicitly (`{{ greet(name) }}`), and a
  value you want to inspect rather than invoke should not be a bare function.

An object or plain value global is used as-is (objects are truthy, not called).

## Basic Syntax

```twig
{# Output variables #}
<h1>{{ title }}</h1>
<p>{{ user.name }}</p>
<p>{{ user.email | upper }}</p>

{# Conditionals #}
{% if user.active %}
    <span class="badge-green">Active</span>
{% else %}
    <span class="badge-red">Inactive</span>
{% endif %}

{# Loops #}
{% for user in users %}
    <div>{{ loop.index }}. {{ user.name }}</div>
{% else %}
    <p>No users found.</p>
{% endfor %}

{# Template inheritance #}
{% extends "base.twig" %}
{% block content %}
    <h1>Page Title</h1>
{% endblock %}
```

## Useful Filters

```twig
{{ name | upper }}                 → UPPERCASE
{{ name | lower }}                 → lowercase
{{ name | capitalize }}            → First letter cap
{{ text | truncate(100) }}         → Truncate
{{ list | join(", ") }}            → Join array
{{ value | default("N/A") }}       → Default if null
{{ html | raw }}                   → No auto-escaping
{{ price | number_format(2) }}     → 1,234.56
{{ date | date("%Y-%m-%d") }}      → Formatted date (strftime tokens, not Twig `Y-m-d`)
{{ text | slug }}                  → url-friendly-slug
{# no `timeago` filter — compute in the route and pass the label into the template, or add it via
   `Frond.addFilter("timeago", (t) => ...)` at app boot. #}
```

Filter names are **snake_case** and must render identically across all Tina4 frameworks (see the
Frond Template Parity note in `SKILL.md`).

## Includes and Macros

```twig
{% include "partials/header.twig" %}
{% include "partials/card.twig" with {"title": "Hello"} %}

{% macro input(name, value, type) %}
    <input type="{{ type | default('text') }}" name="{{ name }}" value="{{ value }}">
{% endmacro %}

{% import "macros/forms.twig" as forms %}
{{ forms.input("email", "", "email") }}
```

## Data comes from the route (there is no `{% query %}` tag)

Frond has no SQL tag — an unknown tag such as `{% query %}` throws `Frond: unknown tag "query"`.
Fetch in the route and pass the rows in:

```typescript
// src/routes/products/get.ts
import { Database, getAdapter } from "tina4-nodejs/orm";
export default async function (req, res) {
  const result = await new Database(getAdapter()).fetch("SELECT * FROM products WHERE active = ?", [1]);
  return res.render("products.twig", { products: result.records });
}
```

```twig
{% for product in products %}
    <div>{{ product.name }} — ${{ product.price | number_format(2) }}</div>
{% endfor %}
```

## Live Blocks (server-rendered, self-refreshing)

A live block renders on the server for first paint, then re-fetches its own HTML and swaps it in
place. Pick a transport: `poll N` (every N seconds), `sse`, or `ws "path"`. The framework's bundled
client wires the marker and morphs the result, so a focused input survives the swap.

```twig
{# Poll every 5 seconds #}
{% live "cart" poll 5 %}
    <strong>{{ count }}</strong> items
{% endlive %}

{# WebSocket — the server pushes updates #}
{% live "chat" ws "/ws/chat" %}
    {% for msg in messages %}<div>{{ msg.user }}: {{ msg.text }}</div>{% endfor %}
{% endlive %}
```

The block name is the refresh route (`GET /__frond/live/{name}`); supply its data with a provider
registered by name. Because the provider runs on every refresh with the live request, auth re-applies
each time:

```typescript
import { Frond } from "tina4-nodejs/frond";
Frond.liveSource("cart", (request) => ({ count: cartCount(request), items: cartItems(request) }));
```

For a `ws` block, push a fresh render the instant data changes with `Frond.pushLive("cart", {...})`.

## Cache Blocks

```twig
{% cache "sidebar" 300 %}
    {# cached for 300 seconds — fetch `posts` in the route and pass it in #}
    {% for post in posts %}
        <a href="/posts/{{ post.id }}">{{ post.title }}</a>
    {% endfor %}
{% endcache %}
```

## Styling

Use **Tina4CSS** — the bundled Bootstrap-compatible stylesheet in `public/css/` (copied into the
project by `tina4nodejs init`). No CDN, no npm, no Tailwind. Layout/components: `container`, `row`,
`col`, `card`, `btn`, `form-control`, `navbar`, and the `mt-*` / `d-flex` utilities. **No inline
styles** — create a CSS class in `public/css/` instead of writing `style="..."`.
