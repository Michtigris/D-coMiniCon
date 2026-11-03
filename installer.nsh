; Une seule version active : tue les process, désinstalle les copies, efface les dossiers, reset autostart.

!include "LogicLib.nsh"

!macro customHeader
  !define MUI_FINISHPAGE_TITLE "Installation réussie"
  !define MUI_FINISHPAGE_TEXT "Une seule DécoMiniCon est installée (celle-ci).$\r$\n$\r$\nOuvre avec ton mot-clé (ANGE par défaut)."
  !define MUI_FINISHPAGE_BUTTON "Terminer"
!macroend

!macro SilentUninstall DIR
  ${If} ${FileExists} "${DIR}\Uninstall DécoMiniCon.exe"
    ExecWait '"${DIR}\Uninstall DécoMiniCon.exe" /S _?=${DIR}'
    Sleep 400
  ${ElseIf} ${FileExists} "${DIR}\Uninstall decominicon.exe"
    ExecWait '"${DIR}\Uninstall decominicon.exe" /S _?=${DIR}'
    Sleep 400
  ${EndIf}
  RMDir /r "${DIR}"
!macroend

!macro customInit
  ; 1) Ferme toutes les instances DécoMiniCon (pas les autres Electron).
  ExecWait 'taskkill /F /IM "DécoMiniCon.exe"'
  ExecWait 'taskkill /F /IM "decominicon.exe"'
  Sleep 700

  ; 2) Désinstalle proprement puis efface chaque emplacement connu.
  !insertmacro SilentUninstall "$LOCALAPPDATA\Programs\DécoMiniCon"
  !insertmacro SilentUninstall "$LOCALAPPDATA\Programs\decominicon"
  !insertmacro SilentUninstall "$PROGRAMFILES\DécoMiniCon"
  !insertmacro SilentUninstall "$PROGRAMFILES\decominicon"
  !insertmacro SilentUninstall "$PROGRAMFILES64\DécoMiniCon"
  !insertmacro SilentUninstall "$PROGRAMFILES64\decominicon"

  ; 3) Cache updater + reste éventuel.
  RMDir /r "$LOCALAPPDATA\decominicon-updater"

  ; 4) Anciennes entrées démarrage / désinstall (évite ANGE → mauvaise exe).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "DécoMiniCon"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "decominicon"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.DécoMiniCon"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.decominicon"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\decominicon"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DécoMiniCon"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{fr.decominicon.app}"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\decominicon"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\DécoMiniCon"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{fr.decominicon.app}"
  DeleteRegKey HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\decominicon"
  DeleteRegKey HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\DécoMiniCon"
!macroend

!macro customInstall
  FileOpen $0 "$INSTDIR\INSTALLE.txt" w
  FileWrite $0 "DécoMiniCon — seule version active$\r$\n"
  FileWrite $0 "Mot-clé : ANGE (modifiable dans les réglages)$\r$\n"
  FileClose $0

  ; Force le démarrage auto vers CETTE exe (écoute ANGE).
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "DécoMiniCon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hidden'
!macroend
