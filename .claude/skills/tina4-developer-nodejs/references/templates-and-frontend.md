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

## Inline SQL Queries (Frond-unique)

```twig
{% query "SELECT * FROM products WHERE active = ?" params=[true] as products %}
{% for product in products.data %}
    <div>{{ product.name }} — ${{ product.price | number_format(2) }}</div>
{% endfor %}
<p>{{ products.total }} products found</p>
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
each time. Confirm the exact provider-registration API for your version with the live API index.

## Cache Blocks

```twig
{% cache "sidebar" 300 %}
    {# cached for 300 seconds #}
    {% query "SELECT * FROM popular_posts LIMIT 10" as posts %}
    {% for post in posts.data %}
        <a href="/posts/{{ post.id }}">{{ post.title }}</a>
    {% endfor %}
{% endcache %}
```

## Styling

Use **Tina4CSS** — the bundled Bootstrap-compatible stylesheet in `public/css/` (copied into the
project by `tina4nodejs init`). No CDN, no npm, no Tailwind. Layout/components: `container`, `row`,
`col`, `card`, `btn`, `form-control`, `navbar`, and the `mt-*` / `d-flex` utilities. **No inline
styles** — create a CSS class in `public/css/` instead of writing `style="..."`.
