# Todo App — Tina4 Node.js

Minimal todo API demonstrating Tina4 conventions.

## Run

```bash
cd examples/todo-app
npx tsx app.ts
```

## API

| Method | Path               | Description   |
|--------|--------------------|---------------|
| GET    | /api/todos         | List todos    |
| POST   | /api/todos         | Create todo   |
| GET    | /api/todos/{id}    | Get one todo  |
| PUT    | /api/todos/{id}    | Update todo   |
| DELETE | /api/todos/{id}    | Delete todo   |

## Structure

```
app.ts                              # Entry point
src/models/todo.ts                  # Todo model definition
src/routes/api/todos/get.ts         # GET  /api/todos
src/routes/api/todos/post.ts        # POST /api/todos
src/routes/api/todos/{id}/get.ts    # GET  /api/todos/{id}
src/routes/api/todos/{id}/put.ts    # PUT  /api/todos/{id}
src/routes/api/todos/{id}/delete.ts # DELETE /api/todos/{id}
src/templates/index.html            # Frond template
```

## Cross-Framework Parity

This exact same structure, API, and patterns exist in all 4 Tina4 frameworks:

| File             | Python          | PHP             | Node.js         | Ruby            |
|------------------|-----------------|-----------------|-----------------|-----------------|
| Entry point      | `app.py`        | `index.php`     | `app.ts`        | `app.rb`        |
| Model            | `todo.py`       | `Todo.php`      | `todo.ts`       | `todo.rb`       |
| Routes           | `get.py` etc.   | `get.php` etc.  | `get.ts` etc.   | `get.rb` etc.   |
| Template         | `index.html`    | `index.html`    | `index.html`    | `index.html`    |
| Response pattern | `response()`    | `$response()`   | `response()`    | `response.json` |
| HTTP constants   | `HTTP_OK`       | `HTTP_OK`       | `HTTP_OK`       | `Tina4::HTTP_OK`|
