; ─────────────────────────────────────────────────────────────────────────
; Browy — Windows installer
;
; Per-user install (no UAC prompt). Lays out:
;   %LOCALAPPDATA%\Programs\Browy\
;     node.exe
;     dist\
;     node_modules\
;     extension\          (browser extension — load unpacked from here)
;     package.json
;     uninstall.exe
;
; Postinstall step runs `node.exe dist\cli-bin.js install-host` which
; registers the native messaging host with Chrome / Edge / Brave so the
; Browy extension can talk to it.
; ─────────────────────────────────────────────────────────────────────────

!define APP_NAME       "Browy"
!define APP_PUBLISHER  "Ritabrata Maiti"
!define APP_VERSION    "0.1.0"
!define APP_URL        "https://github.com/BrowyHQ/browy"
!define UNINST_KEY     "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "..\release\Browy-Setup-${APP_VERSION}.exe"
Unicode true

; Per-user install — never prompts UAC.
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"
SetCompressor /SOLID lzma

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName"     "${APP_NAME}"
VIAddVersionKey "CompanyName"     "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "FileVersion"     "${APP_VERSION}"
VIAddVersionKey "ProductVersion"  "${APP_VERSION}"
VIAddVersionKey "LegalCopyright"  "Copyright (c) Ritabrata Maiti"

; ── UI ──────────────────────────────────────────────────────────────────
!include "MUI2.nsh"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_TITLE "Browy is installed"
!define MUI_FINISHPAGE_TEXT "The Browy backend is registered with Chrome / Edge / Brave.$\r$\n$\r$\nTo finish, install the browser extension:$\r$\n  1. Open chrome://extensions$\r$\n  2. Enable 'Developer mode' (top-right)$\r$\n  3. Click 'Load unpacked' and select:$\r$\n     $INSTDIR\extension$\r$\n  4. Pin Browy and open the side panel"

; Two clickable shortcuts on the Finish page.
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION OpenExtensionFolder
!define MUI_FINISHPAGE_RUN_TEXT "Open the extension folder in Explorer"

!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION OpenChromeExtensions
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Open chrome://extensions"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!define MUI_FINISHPAGE_LINK "Browy on GitHub"
!define MUI_FINISHPAGE_LINK_LOCATION "${APP_URL}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ── Install ─────────────────────────────────────────────────────────────
Section "Install"
  SetOutPath "$INSTDIR"

  ; Copy the staged tree (built by `node scripts/stage.mjs --target=win-x64`)
  File /r "..\stage\win-x64\Browy\*"

  ; Register native messaging host. Runs *our* bundled node so the host
  ; manifest's `path` always points at the install we just laid down,
  ; regardless of what version of Node (if any) the user has on PATH.
  ; ExecWait works reliably in both UI and silent (/S) install modes;
  ; nsExec::* variants have issues under /S without an attached console.
  DetailPrint "Registering native messaging host with Chrome / Edge / Brave..."
  ExecWait '"$INSTDIR\node.exe" "$INSTDIR\dist\cli-bin.js" install-host' $0
  ${If} $0 != 0
    DetailPrint "WARNING: install-host returned exit code $0. Re-run manually:"
    DetailPrint "  $INSTDIR\node.exe $INSTDIR\dist\cli-bin.js install-host"
  ${Else}
    DetailPrint "Native messaging host registered successfully."
  ${EndIf}

  ; Add/Remove Programs entry
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName"     "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion"  "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher"       "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout"    "${APP_URL}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"

  ; Estimated installed size in KB (rough — used by Programs & Features)
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" 360000

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

; ── Finish-page button handlers ─────────────────────────────────────────
Function OpenExtensionFolder
  ExecShell "open" "$INSTDIR\extension"
FunctionEnd

Function OpenChromeExtensions
  ; Try Chrome first (handles chrome:// natively); fall back to start-shell
  ; which lets the OS pick the registered handler (Chrome / Edge / Brave).
  ExecShell "open" "chrome://extensions"
FunctionEnd

; ── Uninstall ───────────────────────────────────────────────────────────
Section "Uninstall"
  ; Best-effort: unregister the native messaging host. Don't fail uninstall
  ; if this errors — files will still be removed.
  ExecWait '"$INSTDIR\node.exe" "$INSTDIR\dist\cli-bin.js" uninstall-host' $0

  ; Wipe install dir.
  RMDir /r "$INSTDIR"

  ; Registry cleanup.
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP_NAME}"
SectionEnd
