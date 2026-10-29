!include TextFunc.nsh
!define WAYRILL_HOOK_DIR "${__FILEDIR__}"
!macro WayrillReadInstallerLog Action LogPath
  Pop $0
  StrCpy $1 ""
  ClearErrors
  FileOpen $2 "${LogPath}" r
  IfErrors wayrill_log_${Action}_missing
  wayrill_log_${Action}_next:
    ClearErrors
    FileReadUTF16LE $2 $3
    IfErrors wayrill_log_${Action}_done
    ${TrimNewLines} $3 $3
    DetailPrint $3
    StrCpy $1 "$1$3$\r$\n"
    Goto wayrill_log_${Action}_next
  wayrill_log_${Action}_done:
    FileClose $2
    Goto wayrill_log_${Action}_check
  wayrill_log_${Action}_missing:
    StrCpy $1 "Setup did not return its diagnostic log."
    DetailPrint $1
    StrCpy $0 1
  wayrill_log_${Action}_check:
!macroend
!macro WayrillCheckExit Action
  !insertmacro WayrillReadInstallerLog ${Action} "$PLUGINSDIR\Wayrill-Service.log"
  ${If} $0 != 0
    IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "Wayrill service setup failed:$\r$\n$1"
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend
!macro NSIS_HOOK_PREINSTALL
  ${If} $INSTDIR != "$PROGRAMFILES64\Wayrill"
    IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "Install Wayrill in Program Files to protect its networking service."
    SetErrorLevel 1
    Abort
  ${EndIf}
  Call WayrillPrepareResources
  Call WayrillUninstallPreviousVersion
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=Installer-Service.ps1 "${WAYRILL_HOOK_DIR}\..\service\scripts\Installer-Service.ps1"
  File /oname=Installer-Lifecycle.ps1 "${WAYRILL_HOOK_DIR}\..\service\scripts\Installer-Lifecycle.ps1"
  File /oname=installer-manifest.json "${WAYRILL_HOOK_DIR}\..\.tools\installer-service\manifest.json"
  File /oname=upgrade-protection.exe "${WAYRILL_HOOK_DIR}\..\.tools\installer-service\wayrill-service.exe"
  Delete "$PLUGINSDIR\Wayrill-Service.log"
  ${DisableX64FSRedirection}
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\Installer-Service.ps1" -Action Prepare -LogPath "$PLUGINSDIR\Wayrill-Service.log"'
  ${EnableX64FSRedirection}
  !insertmacro WayrillCheckExit Prepare
  SetOutPath "$INSTDIR"
!macroend
!macro NSIS_HOOK_POSTINSTALL
  !insertmacro MUI_HEADER_TEXT "Restarting Wayrill service" "Starting the networking service and restoring the previous routing state."
  DetailPrint "Restarting Wayrill service"
  SetOutPath "$INSTDIR\Service\windivert"
  SetOverwrite off
  File /oname=WinDivert64.sys "${WAYRILL_HOOK_DIR}\..\.tools\installer-service\windivert\WinDivert64.sys"
  SetOverwrite on
  Delete "$PLUGINSDIR\Wayrill-Service.log"
  ${DisableX64FSRedirection}
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\Service\scripts\Installer-Service.ps1" -Action Install -PreviousManifest "$PLUGINSDIR\previous-manifest.json" -LogPath "$PLUGINSDIR\Wayrill-Service.log"'
  ${EnableX64FSRedirection}
  !insertmacro WayrillCheckExit Install
  ${If} $WayrillResourcesRequested = 1
    WriteRegDWORD HKLM "SOFTWARE\Wayrill" "ResourceFiles" $WayrillResourcesMask
  ${EndIf}
  IfFileExists "$INSTDIR\Service\Installation-Recovery.txt" 0 wayrill_profile_recovery_done
    DetailPrint "Installation completed. Previous routing needs attention; see Installation-Recovery.txt."
    IfSilent wayrill_profile_recovery_done
    MessageBox MB_ICONEXCLAMATION|MB_OK "Wayrill was installed successfully, but previous routing could not be restored.$\r$\n$\r$\nOpen Wayrill to inspect Runtime and Help > Application logs. Check your saved graph before starting routing.$\r$\n$\r$\nThe error is saved in Service\Installation-Recovery.txt. The original profile was preserved. Your graph and Stash have not been reset."
  wayrill_profile_recovery_done:
  SetOutPath "$INSTDIR"
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  InitPluginsDir
  CopyFiles /SILENT "$INSTDIR\Service\scripts\Installer-Service.ps1" "$PLUGINSDIR\Installer-Service.ps1"
  CopyFiles /SILENT "$INSTDIR\Service\scripts\Installer-Lifecycle.ps1" "$PLUGINSDIR\Installer-Lifecycle.ps1"
  Delete "$PLUGINSDIR\Wayrill-Service.log"
  ${DisableX64FSRedirection}
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\Installer-Service.ps1" -Action Uninstall -LogPath "$PLUGINSDIR\Wayrill-Service.log"'
  ${EnableX64FSRedirection}
  !insertmacro WayrillCheckExit Uninstall
  SetOutPath "$INSTDIR"
!macroend
