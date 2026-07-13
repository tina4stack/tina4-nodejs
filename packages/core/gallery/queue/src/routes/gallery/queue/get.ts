/** Gallery: Queue — interactive queue demo with visual web UI. */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (_req: Tina4Request, res: Tina4Response) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Queue Gallery — Tina4 Node.js</title>
    <link rel="stylesheet" href="/css/tina4.min.css">
</head>
<body>
<div class="container mt-4 mb-4">
    <h1>Queue Gallery</h1>
    <p class="text-muted">Interactive demo of Tina4's database-backed job queue. Produce messages, consume them, simulate failures, and inspect dead letters.</p>

    <div class="row mt-3">
        <div class="col-md-6">
            <div class="card">
                <div class="card-header">Produce a Message</div>
                <div class="card-body">
                    <div class="d-flex gap-2">
                        <input type="text" id="msgInput" class="form-control" placeholder="Enter a task message, e.g. send-email">
                        <button class="btn btn-primary" onclick="produce()">Produce</button>
                    </div>
                </div>
            </div>
        </div>
        <div class="col-md-6">
            <div class="card">
                <div class="card-header">Actions</div>
                <div class="card-body d-flex gap-2 flex-wrap">
                    <button class="btn btn-success" onclick="consume()">Consume Next</button>
                    <button class="btn btn-danger" onclick="failNext()">Fail Next</button>
                    <button class="btn btn-warning" onclick="retryFailed()">Retry Failed</button>
                    <button class="btn btn-secondary" onclick="refresh()">Refresh</button>
                </div>
            </div>
        </div>
    </div>

    <div id="alertArea" class="mt-3"></div>

    <div class="card mt-3">
        <div class="card-header d-flex justify-content-between align-items-center">
            <span>Queue Messages</span>
            <small class="text-muted" id="lastRefresh"></small>
        </div>
        <div class="card-body p-0">
            <table class="table table-striped mb-0">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Data</th>
                        <th>Status</th>
                        <th>Attempts</th>
                        <th>Error</th>
                        <th>Created</th>
                    </tr>
                </thead>
                <tbody id="queueBody">
                    <tr><td colspan="6" class="text-center text-muted">Loading...</td></tr>
                </tbody>
            </table>
        </div>
    </div>
</div>

<script>
function statusBadge(status) {
    var colors = {pending:"primary", reserved:"warning", completed:"success", failed:"danger", dead:"secondary"};
    var color = colors[status] || "secondary";
    return '<span class="badge bg-' + color + '">' + status + '</span>';
}

function showAlert(msg, type) {
    var area = document.getElementById("alertArea");
    area.innerHTML = '<div class="alert alert-' + type + ' alert-dismissible">' + msg +
        '<button type="button" class="btn-close" onclick="this.parentElement.remove()"></button></div>';
    setTimeout(function(){ area.innerHTML = ""; }, 3000);
}

function truncate(s, n) {
    if (!s) return "";
    return s.length > n ? s.substring(0, n) + "..." : s;
}

async function refresh() {
    try {
        var r = await fetch("/api/gallery/queue/status");
        var data = await r.json();
        var tbody = document.getElementById("queueBody");
        if (!data.messages || data.messages.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No messages in queue. Produce one above.</td></tr>';
        } else {
            var html = "";
            for (var i = 0; i < data.messages.length; i++) {
                var m = data.messages[i];
                html += "<tr><td>" + m.id + "</td><td><code>" + truncate(m.data, 60) + "</code></td><td>" +
                    statusBadge(m.status) + "</td><td>" + m.attempts + "</td><td>" +
                    truncate(m.error || "", 40) + "</td><td><small>" + (m.created_at || "") + "</small></td></tr>";
            }
            tbody.innerHTML = html;
        }
        document.getElementById("lastRefresh").textContent = "Updated " + new Date().toLocaleTimeString();
    } catch (e) {
        console.error(e);
    }
}

async function produce() {
    var input = document.getElementById("msgInput");
    var task = input.value.trim() || "demo-task";
    var r = await fetch("/api/gallery/queue/produce", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({task: task, data: {message: task}})
    });
    var d = await r.json();
    showAlert("Produced message: " + task, "success");
    input.value = "";
    refresh();
}

async function consume() {
    var r = await fetch("/api/gallery/queue/consume", {method:"POST"});
    var d = await r.json();
    if (d.consumed) {
        showAlert("Consumed job #" + d.job_id + " successfully", "success");
    } else {
        showAlert(d.message || "Nothing to consume", "info");
    }
    refresh();
}

async function failNext() {
    var r = await fetch("/api/gallery/queue/fail", {method:"POST"});
    var d = await r.json();
    if (d.failed) {
        showAlert("Deliberately failed job #" + d.job_id, "danger");
    } else {
        showAlert(d.message || "Nothing to fail", "info");
    }
    refresh();
}

async function retryFailed() {
    var r = await fetch("/api/gallery/queue/retry", {method:"POST"});
    var d = await r.json();
    showAlert("Retried " + (d.retried || 0) + " failed message(s)", "warning");
    refresh();
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
  return res.html(html);
}
