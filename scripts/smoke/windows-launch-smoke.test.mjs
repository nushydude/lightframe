import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const smokeScript = path.join(import.meta.dirname, 'windows-launch-smoke.ps1');

async function smokeSource() {
  return fs.readFile(smokeScript, 'utf8');
}

test('Windows smoke runner keeps a CI-friendly startup wait and late-window grace period', async () => {
  const source = await smokeSource();

  assert.match(source, /\[int\]\$TimeoutSeconds = 45/);
  assert.match(source, /\[int\]\$WindowStablePolls = 2/);
  assert.match(source, /\[int\]\$RespondingGraceSeconds = 5/);
  assert.match(
    source,
    /\$respondingGraceDeadline = \(Get-Date\)\.AddSeconds\(\$RespondingGraceSeconds\)/
  );
  assert.match(source, /\$stableWindowPolls -lt \$WindowStablePolls/);
});

test('Windows smoke runner preserves process, crash, and settings cleanup safeguards', async () => {
  const source = await smokeSource();

  assert.match(source, /Get-LightFrameCrashEvents -StartTime \$startedAt/);
  assert.match(source, /LightFrame exited before showing a main window/);
  assert.match(source, /fresh crash-reporting events were recorded/);
  assert.match(source, /taskkill\.exe \/PID \$process\.Id \/T \/F/);
  assert.match(source, /Move-Item -LiteralPath \$backupPath -Destination \$settingsPath -Force/);
  assert.match(source, /Remove-Item -LiteralPath \$settingsPath -Force/);
});
