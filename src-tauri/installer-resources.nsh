!include nsDialogs.nsh
Var WayrillResourcesMask
Var WayrillExistingInstall
Var WayrillResourcesRequested
Var WayrillRussianCheck
Var WayrillIranianCheck
Var WayrillChineseCheck

Function WayrillLoadResourceSelection
  SetRegView 64
  StrCpy $WayrillExistingInstall 0
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} $R0 != ""
    StrCpy $WayrillExistingInstall 1
  ${EndIf}
  ClearErrors
  ReadRegDWORD $WayrillResourcesMask HKLM "SOFTWARE\Wayrill" "ResourceFiles"
  ${If} ${Errors}
    StrCpy $WayrillResourcesMask 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/RESOURCES=" $R0
  ${IfNot} ${Errors}
    StrCpy $WayrillResourcesMask $R0
  ${EndIf}
  ${If} $WayrillResourcesMask < 0
  ${OrIf} $WayrillResourcesMask > 15
    StrCpy $WayrillResourcesMask 1
  ${EndIf}
  IntOp $WayrillResourcesMask $WayrillResourcesMask | 1
FunctionEnd

Function WayrillSetResourceMode
  StrCpy $WayrillResourcesRequested 1
  ${If} $UpdateMode = 1
    StrCpy $WayrillResourcesRequested 0
  ${ElseIf} $WayrillExistingInstall = 1
  ${AndIf} $ReinstallPageCheck <> 2
  ${AndIf} $WixMode <> 1
    StrCpy $WayrillResourcesRequested 0
  ${EndIf}
FunctionEnd

!macro WayrillResourceCheckbox Label Y Flag Variable
  ${NSD_CreateCheckbox} 0 ${Y}u 100% 18u "${Label}"
  Pop ${Variable}
  IntOp $R0 $WayrillResourcesMask & ${Flag}
  ${If} $R0 != 0
    ${NSD_Check} ${Variable}
  ${EndIf}
!macroend

Page custom WayrillResourcePage WayrillLeaveResourcePage
Function WayrillResourcePage
  Call WayrillSetResourceMode
  ${If} $WayrillResourcesRequested = 0
    Abort
  ${EndIf}
  Call SkipIfPassive
  !insertmacro MUI_HEADER_TEXT "Resource files" "XTLS files are included. Choose any additional downloads."
  nsDialogs::Create 1018
  Pop $R0
  ${If} $R0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 12u 100% 18u "Original (XTLS) - included, works offline"
  Pop $R0
  !insertmacro WayrillResourceCheckbox "Russian (RunetFreedom, full files)" 40 2 $WayrillRussianCheck
  !insertmacro WayrillResourceCheckbox "Iranian (Chocolate4U)" 68 4 $WayrillIranianCheck
  !insertmacro WayrillResourceCheckbox "Chinese (Loyalsoldier)" 96 8 $WayrillChineseCheck
  ${NSD_CreateLabel} 0 122u 100% 24u "Optional files download from the Internet. Add files later in Settings > Resource files."
  Pop $R0
  nsDialogs::Show
FunctionEnd

Function WayrillLeaveResourcePage
  StrCpy $WayrillResourcesMask 1
  ${NSD_GetState} $WayrillRussianCheck $R0
  ${If} $R0 == ${BST_CHECKED}
    IntOp $WayrillResourcesMask $WayrillResourcesMask | 2
  ${EndIf}
  ${NSD_GetState} $WayrillIranianCheck $R0
  ${If} $R0 == ${BST_CHECKED}
    IntOp $WayrillResourcesMask $WayrillResourcesMask | 4
  ${EndIf}
  ${NSD_GetState} $WayrillChineseCheck $R0
  ${If} $R0 == ${BST_CHECKED}
    IntOp $WayrillResourcesMask $WayrillResourcesMask | 8
  ${EndIf}
FunctionEnd

Function WayrillPrepareResources
  Call WayrillSetResourceMode
  ${If} $WayrillResourcesRequested = 0
    Return
  ${EndIf}
  IntOp $R0 $WayrillResourcesMask & 14
  ${If} $R0 = 0
    Return
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=Installer-Resources.ps1 "${WAYRILL_HOOK_DIR}\..\service\scripts\Installer-Resources.ps1"
  File /oname=Resource-Downloads.ps1 "${WAYRILL_HOOK_DIR}\..\service\scripts\Resource-Downloads.ps1"
  File /oname=resource-dependencies.json "${WAYRILL_HOOK_DIR}\..\service\dependencies.json"
  !insertmacro MUI_HEADER_TEXT "Downloading resource files" "The existing installation stays running until downloads finish."
  wayrill_resources_retry:
    Delete "$PLUGINSDIR\Wayrill-Resources.log"
    ${DisableX64FSRedirection}
    nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\Installer-Resources.ps1" -Manifest "$PLUGINSDIR\resource-dependencies.json" -Mask $WayrillResourcesMask -Destination "$PLUGINSDIR\resources" -LogPath "$PLUGINSDIR\Wayrill-Resources.log"'
    ${EnableX64FSRedirection}
    !insertmacro WayrillReadInstallerLog Resources "$PLUGINSDIR\Wayrill-Resources.log"
    ${If} $0 != 0
      IfSilent wayrill_resources_abort
      MessageBox MB_ICONSTOP|MB_RETRYCANCEL "Resource download failed:$\r$\n$1$\r$\nRetry, or cancel setup and deselect optional files. The existing installation is unchanged." IDRETRY wayrill_resources_retry
      wayrill_resources_abort:
      SetErrorLevel 1
      Abort
    ${EndIf}
FunctionEnd

Function WayrillInstallDownloadedResources
  ${If} $WayrillResourcesRequested = 1
    IfFileExists "$PLUGINSDIR\resources\*.dat" 0 wayrill_resources_done
    ClearErrors
    CopyFiles /SILENT "$PLUGINSDIR\resources\*.dat" "$INSTDIR\Service\xray"
    ${If} ${Errors}
      IfSilent +2
      MessageBox MB_ICONSTOP|MB_OK "Could not install the downloaded resource files. Retry setup."
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
  wayrill_resources_done:
FunctionEnd
