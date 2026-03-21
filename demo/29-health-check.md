# Health Check

Tina4 automatically registers a `GET /health` endpoint that returns server status, version, and uptime. No configuration needed.

## Endpoint

```
GET /health
```

## Response

```json
{
  "status": "ok",
  "version": "3.0.0",
  "uptime": 1234.56,
  "framework": "tina4-nodejs"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | Always `"ok"` if the server is responding |
| `version` | `string` | Framework version |
| `uptime` | `number` | Seconds since server started (2 decimal places) |
| `framework` | `string` | Always `"tina4-nodejs"` |

## Swagger Documentation

The health endpoint is automatically documented in Swagger:

- **Summary:** Health check
- **Description:** Returns server health status, version, and uptime.
- **Tag:** System

## Use Cases

- **Load balancer health checks** -- point your ALB/NLB health check to `/health`.
- **Monitoring** -- integrate with uptime monitoring services.
- **Kubernetes probes** -- use as `livenessProbe` and `readinessProbe`.

## Example: Kubernetes Deployment

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 7148
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /health
    port: 7148
  initialDelaySeconds: 3
  periodSeconds: 5
```

## Notes

- The health route is registered before file-based routes and auto-CRUD routes.
- Uptime is calculated from the moment `createHealthRoute()` is called during server startup.
- The endpoint does not check database connectivity -- it confirms the HTTP server is responsive.
