const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Préfixes pour matcher un onglet déjà ouvert (ex. https://jklm.fun/ → https://jklm…). */
function urlMatchPrefixes(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [String(rawUrl || '').trim().toLowerCase()].filter(Boolean);
  }
  const href = parsed.href.replace(/\/$/, '');
  const origin = parsed.origin;
  const host = parsed.hostname.toLowerCase();
  const first = host.split('.')[0] || host;
  const soft = `${parsed.protocol}//${first}`.toLowerCase();
  const list = [
    href.toLowerCase(),
    `${href}/`.toLowerCase(),
    origin.toLowerCase(),
    `${origin}/`.toLowerCase(),
    soft
  ];
  return [...new Set(list.filter(Boolean))];
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Cherche un onglet navigateur dont l’URL commence par un des préfixes,
 * l’active et ramène la fenêtre au premier plan.
 * Retourne { ok, matched?, opened? }.
 */
function findAndFocusTab(prefixes) {
  const list = (Array.isArray(prefixes) ? prefixes : [])
    .map((p) => String(p || '').trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return Promise.resolve({ ok: false, reason: 'prefix' });

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DecoFg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  public static void Focus(IntPtr hwnd) {
    uint pid; uint fore = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint self = GetCurrentThreadId(); uint target = GetWindowThreadProcessId(hwnd, out pid);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    AttachThreadInput(self, fore, true); AttachThreadInput(self, target, true);
    ShowWindow(hwnd, 9); BringWindowToTop(hwnd); SetForegroundWindow(hwnd);
    AttachThreadInput(self, target, false); AttachThreadInput(self, fore, false);
  }
}
"@
$prefixes = @(${list.map(psQuote).join(',')})
function Test-Match([string]$url) {
  if (-not $url) { return $false }
  $u = $url.Trim().ToLowerInvariant()
  foreach ($p in $prefixes) {
    if ($u.StartsWith($p)) { return $true }
  }
  return $false
}
function Get-EditUrl($root) {
  $editCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit)
  $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
  foreach ($edit in $edits) {
    try {
      $name = [string]$edit.Current.Name
      if ($name -and ($name -match 'Address|Adresse|Search|Recherche|Omnibox')) {
        $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($vp -and $vp.Current.Value) { return [string]$vp.Current.Value }
      }
    } catch {}
  }
  foreach ($edit in $edits) {
    try {
      $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $val = [string]$vp.Current.Value
      if ($val -match '^https?://') { return $val }
    } catch {}
  }
  return $null
}
function Focus-Window($el) {
  try {
    $hwnd = [IntPtr]$el.Current.NativeWindowHandle
    if ($hwnd -ne [IntPtr]::Zero) { [DecoFg]::Focus($hwnd) }
  } catch {}
}
$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Window)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
foreach ($win in $windows) {
  try {
    $cls = [string]$win.Current.ClassName
    $name = [string]$win.Current.Name
    $isBrowser = ($cls -eq 'Chrome_WidgetWin_1' -or $cls -eq 'MozillaWindowClass' -or $cls -eq 'ApplicationFrameWindow' -or $name -match 'Chrome|Edge|Firefox|Brave|Opera')
    if (-not $isBrowser) { continue }
    if ($cls -eq 'Chrome_WidgetWin_1' -and -not $name) { continue }
    $url = Get-EditUrl $win
    if (Test-Match $url) {
      Focus-Window $win
      Write-Output ('MATCH|' + $url)
      exit 0
    }
    $tabCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TabItem)
    $tabs = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
    if ($tabs.Count -le 1) { continue }
    $limit = [Math]::Min(12, $tabs.Count)
    for ($i = 0; $i -lt $limit; $i++) {
      $tab = $tabs.Item($i)
      try {
        $sel = $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($sel) { $sel.Select() } else {
          $inv = $tab.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          if ($inv) { $inv.Invoke() }
        }
      } catch { continue }
      Start-Sleep -Milliseconds 70
      $url = Get-EditUrl $win
      if (Test-Match $url) {
        Focus-Window $win
        Write-Output ('MATCH|' + $url)
        exit 0
      }
    }
  } catch { continue }
}
Write-Output 'NONE'
exit 1
`;

  const file = path.join(os.tmpdir(), `decominicon-url-${process.pid}.ps1`);
  return new Promise((resolve) => {
    try {
      fs.writeFileSync(file, script, 'utf8');
    } catch (err) {
      resolve({ ok: false, reason: err.message });
      return;
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      { windowsHide: true, timeout: 12000 },
      (err, stdout) => {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // ignore
        }
        const out = String(stdout || '').trim();
        if (out.startsWith('MATCH|')) {
          resolve({ ok: true, matched: true, url: out.slice(6) });
          return;
        }
        resolve({ ok: false, matched: false, reason: err ? err.message : 'none' });
      }
    );
  });
}

function focusAnyBrowser() {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DecoFg2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public static IntPtr Found = IntPtr.Zero;
  public static bool Cb(IntPtr hWnd, IntPtr lParam) {
    if (!IsWindowVisible(hWnd)) return true;
    var sb = new System.Text.StringBuilder(256);
    GetClassName(hWnd, sb, sb.Capacity);
    var cls = sb.ToString();
    if (cls == "Chrome_WidgetWin_1" || cls == "MozillaWindowClass") {
      Found = hWnd; return false;
    }
    return true;
  }
  public static bool Go() {
    EnumWindows(Cb, IntPtr.Zero);
    if (Found == IntPtr.Zero) return false;
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    ShowWindow(Found, 9); BringWindowToTop(Found); SetForegroundWindow(Found);
    return true;
  }
}
"@
if ([DecoFg2]::Go()) { 'OK' } else { 'NONE' }
`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        resolve({ ok: !err && String(stdout || '').includes('OK') });
      }
    );
  });
}

async function openOrFocusUrl(rawUrl, openExternal) {
  const url = String(rawUrl || '').trim();
  if (!url) return { ok: false, reason: 'Lien vide' };
  const prefixes = urlMatchPrefixes(url);

  const existing = await findAndFocusTab(prefixes);
  if (existing.ok) return { ok: true, matched: true, url: existing.url };

  try {
    await openExternal(url);
  } catch (err) {
    return { ok: false, reason: err.message || 'Ouverture impossible' };
  }

  // Laisse le navigateur créer/activer l’onglet, puis force le premier plan.
  for (const wait of [350, 700, 1200]) {
    await sleep(wait);
    const again = await findAndFocusTab(prefixes);
    if (again.ok) return { ok: true, matched: true, opened: true, url: again.url };
    const any = await focusAnyBrowser();
    if (any.ok) return { ok: true, matched: false, opened: true, focused: true };
  }
  return { ok: true, matched: false, opened: true };
}

module.exports = { urlMatchPrefixes, openOrFocusUrl, findAndFocusTab };
