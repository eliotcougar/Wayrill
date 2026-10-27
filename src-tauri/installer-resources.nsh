!include nsDialogs.nsh
Var WayrillResourcesMask
Var WayrillOriginalCheck
Var WayrillRussianCheck
Var WayrillIranianCheck
Var WayrillChineseCheck

Function WayrillLoadResourceSelection
  SetRegView 64
  ClearErrors
  ReadRegDWORD $WayrillResourcesMask HKLM "SOFTWARE\Wayrill" "ResourceFiles"
  ${If} ${Errors}
    StrCpy $WayrillResourcesMask 15
  ${EndIf}
  ${GetOptions} $CMDLINE "/RESOURCES=" $R0
  ${IfNot} ${Errors}
    StrCpy $WayrillResourcesMask $R0
  ${EndIf}
  ${If} $WayrillResourcesMask < 0
  ${OrIf} $WayrillResourcesMask > 15
    StrCpy $WayrillResourcesMask 15
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
  Call SkipIfPassive
  !insertmacro MUI_HEADER_TEXT "Resource files" "Choose the GeoSite and GeoIP file sets to install."
  nsDialogs::Create 1018
  Pop $R0
  ${If} $R0 == error
    Abort
  ${EndIf}
  !insertmacro WayrillResourceCheckbox "Original (XTLS)" 12 1 $WayrillOriginalCheck
  !insertmacro WayrillResourceCheckbox "Russian (RunetFreedom, full files)" 40 2 $WayrillRussianCheck
  !insertmacro WayrillResourceCheckbox "Iranian (Chocolate4U)" 68 4 $WayrillIranianCheck
  !insertmacro WayrillResourceCheckbox "Chinese (Loyalsoldier)" 96 8 $WayrillChineseCheck
  ${NSD_CreateLabel} 0 132u 100% 30u "Existing files are kept. You can download additional files later in Settings > Resource files."
  Pop $R0
  nsDialogs::Show
FunctionEnd

Function WayrillLeaveResourcePage
  StrCpy $WayrillResourcesMask 0
  ${NSD_GetState} $WayrillOriginalCheck $R0
  ${If} $R0 == ${BST_CHECKED}
    IntOp $WayrillResourcesMask $WayrillResourcesMask | 1
  ${EndIf}
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

Function WayrillShouldInstallDat
  Pop $R0
  ${GetFileName} $R0 $R1
  StrCpy $R0 $R1 3
  StrCpy $R1 1
  ${If} $R0 == "ru-"
    StrCpy $R1 2
  ${ElseIf} $R0 == "ir-"
    StrCpy $R1 4
  ${ElseIf} $R0 == "cn-"
    StrCpy $R1 8
  ${EndIf}
  IntOp $R0 $WayrillResourcesMask & $R1
  Push $R0
FunctionEnd
