import type { Tina4Request, Tina4Response } from "@tina4/core";

export const meta = { summary: "Welcome page", tags: ["Pages"] };

export default async function (request: Tina4Request, response: Tina4Response) {
    return response.html(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tina4 Example</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; color: #333; }
        h1 { color: #1a1a2e; }
        a { color: #0066cc; }
        code { background: #f0f0f0; padding: 0.2rem 0.4rem; border-radius: 3px; }
        ul { line-height: 2; }
    </style>
</head>
<body>
    <h1>Welcome to Tina4</h1>
    <p>This is a minimal example application.</p>
    <h2>API Endpoints</h2>
    <ul>
        <li><a href="/api/hello">GET /api/hello</a> &mdash; Hello world JSON</li>
        <li><a href="/api/users">GET /api/users</a> &mdash; List users</li>
        <li><code>POST /api/users</code> &mdash; Create a user</li>
        <li><a href="/api/users/1">GET /api/users/1</a> &mdash; Get user by ID</li>
        <li><a href="/swagger">Swagger UI</a> &mdash; API documentation</li>
    </ul>
</body>
</html>`);
}
