; Installeur / mise à jour — remplace toute ancienne copie (Local + Program Files).

!include "LogicLib.nsh"

!macro customHeader
  !define MUI_FINISHPAGE_TITLE "Mise à jour réussie"
  !define MUI_FINISHPAGE_TEXT "DécoMiniCon est à jour.$\r$\n$\r$\nPour l'ouvrir : tape A N G E sur le clavier."
  !define MUI_FINISHPAGE_BUTTON "Terminer"
!macroend

!macro customInit
  ExecWait 'taskkill /F /IM "DécoMiniCon.exe"'
  ExecWait 'taskkill /F /IM "decominicon.exe"'
  Sleep 600

  ; Anciennes installs (user + machine).
  RMDir /r "$LOCALAPPDATA\Programs\DécoMiniCon"
  RMDir /r "$LOCALAPPDATA\Programs\decominicon"
  RMDir /r "$PROGRAMFILES\DécoMiniCon"
  RMDir /r "$PROGRAMFILES\decominicon"
  RMDir /r "$PROGRAMFILES64\DécoMiniCon"
  RMDir /r "$PROGRAMFILES64\decominicon"
  ; Cache màj bloqué / obsolète.
  RMDir /r "$LOCALAPPDATA\decominicon-updater"
!macroend

!macro customInstall
  FileOpen $0 "$INSTDIR\INSTALLE.txt" w
  FileWrite $0 "DécoMiniCon — installation OK$\r$\n"
  FileWrite $0 "Ouvrir : tape A N G E$\r$\n"
  FileClose $0
!macroend
