# SCSS Compiler

Tina4 includes a zero-dependency SCSS-to-CSS compiler that supports a practical subset of SCSS features. No `sass` or `node-sass` package needed.

## Basic Usage

```typescript
import { ScssCompiler } from "tina4-nodejs";

const scss = new ScssCompiler();

const css = scss.compile(`
  $primary: #2563eb;
  $radius: 8px;

  .button {
    background: $primary;
    border-radius: $radius;
    padding: 8px 16px;

    &:hover {
      background: darken($primary, 10%);
    }

    .icon {
      margin-right: 8px;
    }
  }
`);

console.log(css);
```

## Compiling Files

```typescript
import { ScssCompiler } from "tina4-nodejs";

const scss = new ScssCompiler();

// Compile an SCSS file
const css = scss.compileFile("src/styles/main.scss");
```

## Supported Features

### Variables

```scss
$font-size: 16px;
$color-primary: #333;

body {
  font-size: $font-size;
  color: $color-primary;
}
```

### Nesting

```scss
nav {
  ul {
    list-style: none;

    li {
      display: inline-block;
    }
  }
}
```

### Parent Selector (`&`)

```scss
.link {
  color: blue;

  &:hover {
    color: red;
  }

  &.active {
    font-weight: bold;
  }

  &-icon {
    margin-right: 4px;
  }
}
```

### @import

```scss
// _variables.scss
$primary: #2563eb;

// main.scss
@import "variables";

body {
  color: $primary;
}
```

### @mixin / @include

```scss
@mixin flex-center {
  display: flex;
  align-items: center;
  justify-content: center;
}

.container {
  @include flex-center;
  height: 100vh;
}
```

### Comments

Both `//` line comments and `/* */` block comments are supported. Line comments are stripped from output.

## Configuration

```typescript
import { ScssCompiler } from "tina4-nodejs";
import type { ScssConfig } from "tina4-nodejs";

const scss = new ScssCompiler({
  importPaths: ["src/styles", "node_modules"],  // Directories to search for @import
  variables: {                                    // Pre-set variables
    "primary": "#2563eb",
    "font-size": "16px",
  },
});

// Add import paths after construction
scss.addImportPath("vendor/styles");

// Override variables
scss.setVariable("$primary", "#dc2626");
```

## In a Route Handler

Serve compiled CSS dynamically:

```typescript
// src/routes/css/[...path]/get.ts
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { ScssCompiler } from "tina4-nodejs";

const scss = new ScssCompiler({ importPaths: ["src/styles"] });

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  try {
    const css = scss.compileFile(`src/styles/${req.params.path}.scss`);
    res.header("Content-Type", "text/css; charset=utf-8");
    res.raw.end(css);
  } catch (err) {
    res.status(404).text("Style not found");
  }
}
```

## Notes

- This is a subset compiler. It handles the most common SCSS patterns but does not cover every edge case of the full Sass specification.
- Import paths are resolved relative to the file being compiled or the configured import directories.
- Circular imports are detected and prevented.
- The `$` prefix on variable names is optional when using `setVariable()`.
