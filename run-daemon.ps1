# Restart loop for the OpenClaw MCP Bridge + Cloud Sync Daemon
# Place this in the Windows Task Scheduler or run at login

$serverPath = "C:\AG-Custom-Swarm\goose-openclaw-mcp"
$logFile    = "$serverPath\mcp-bridge.log"

Write-Host "[Daemon] Starting OpenClaw Swarm MCP Bridge + Cloud Sync Daemon..."

# ── Launch Cloud Sync Daemon (persistent, restarts on crash) ──────────
$syncJob = Start-Job -Name "CloudSyncDaemon" -ScriptBlock {
    param($path)
    while ($true) {
        Write-Host "[CloudSync] Starting daemon at $(Get-Date)"
        $p = Start-Process node -ArgumentList "cloud_sync_daemon.cjs" `
            -WorkingDirectory $path `
            -RedirectStandardOutput "$path\cloud-sync.log" `
            -RedirectStandardError  "$path\cloud-sync-err.log" `
            -PassThru -NoNewWindow
        $p.WaitForExit()
        Write-Host "[CloudSync] Daemon exited (code=$($p.ExitCode)). Restarting in 5s..."
        Start-Sleep -Seconds 5
    }
} -ArgumentList $serverPath

Write-Host "[Daemon] Cloud Sync Daemon started (Job: $($syncJob.Id))"

# ── Launch Novel Factory Standalone Daemon ────────────────────────────
$novelPath = "C:\Users\arvin\.openclaw\workspace_novel_factory_cli"
$novelJob = Start-Job -Name "NovelDaemon" -ScriptBlock {
    param($path)
    while ($true) {
        Write-Host "[NovelDaemon] Starting standalone daemon at $(Get-Date)"
        $p = Start-Process node -ArgumentList "novel-factory-orchestrator.js daemon" `
            -WorkingDirectory $path `
            -RedirectStandardOutput "$path\novel-daemon.log" `
            -RedirectStandardError  "$path\novel-daemon-err.log" `
            -PassThru -NoNewWindow
        $p.WaitForExit()
        Write-Host "[NovelDaemon] Daemon exited (code=$($p.ExitCode)). Restarting in 15s..."
        Start-Sleep -Seconds 15
    }
} -ArgumentList $novelPath

Write-Host "[Daemon] Novel Factory Daemon started (Job: $($novelJob.Id))"

# ── Launch Novel Swarm Bridge ─────────────────────────────────────────
$bridgeJob = Start-Job -Name "NovelBridge" -ScriptBlock {
    param($path)
    while ($true) {
        Write-Host "[NovelBridge] Starting swarm bridge at $(Get-Date)"
        $p = Start-Process node -ArgumentList "novel_swarm_bridge.cjs" `
            -WorkingDirectory $path `
            -RedirectStandardOutput "$path\novel-bridge.log" `
            -RedirectStandardError  "$path\novel-bridge-err.log" `
            -PassThru -NoNewWindow
        $p.WaitForExit()
        Write-Host "[NovelBridge] Bridge exited (code=$($p.ExitCode)). Restarting in 15s..."
        Start-Sleep -Seconds 15
    }
} -ArgumentList $serverPath

Write-Host "[Daemon] Novel Swarm Bridge started (Job: $($bridgeJob.Id))"
# ── Launch keepalive to ping Render and prevent free-tier sleep ────────
$keepalive = Start-Process node -ArgumentList "keepalive.js" `
    -WorkingDirectory $serverPath `
    -RedirectStandardOutput "$serverPath\keepalive.log" `
    -RedirectStandardError  "$serverPath\keepalive-err.log" `
    -PassThru -NoNewWindow

Write-Host "[Daemon] Keepalive started (PID: $($keepalive.Id))"

# ── Main loop: MCP Bridge (restarts on crash) ─────────────────────────
while ($true) {
    $startTime = Get-Date
    Write-Host "[MCP Bridge] Launching server at $startTime"

    $proc = Start-Process node -ArgumentList "server.js" `
        -WorkingDirectory $serverPath `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError  "$serverPath\mcp-bridge-err.log" `
        -PassThru -NoNewWindow

    $proc.WaitForExit()
    $exitCode = $proc.ExitCode
    $elapsed  = (Get-Date) - $startTime

    Write-Host "[MCP Bridge] Server exited (code=$exitCode, uptime=$($elapsed.TotalSeconds)s). Restarting in 5s..."
    Start-Sleep -Seconds 5
}
