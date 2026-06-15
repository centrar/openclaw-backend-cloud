# Restart loop for the OpenClaw MCP Bridge
# Place this in the Windows Task Scheduler or run at login

$serverPath = "C:\AG-Custom-Swarm\goose-openclaw-mcp"
$logFile    = "$serverPath\mcp-bridge.log"

Write-Host "[MCP Bridge] Starting OpenClaw Swarm MCP Bridge..."

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
