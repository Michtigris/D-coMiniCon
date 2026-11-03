; Installeur simple — pas d'ExecWait (ça gelait à 90 %), pas de lancement pendant l'install.

!include "LogicLib.nsh"

!macro customHeader
  !define MUI_FINISHPAGE_TITLE "Installation réussie"
  !define MUI_FINISHPAGE_TEXT "DécoMiniCon est installé.$\r$\n$\r$\nPour l'ouvrir : tape A N G E sur le clavier (à la suite, moins de 4 secondes)."
  !define MUI_FINISHPAGE_BUTTON "Terminer"
!macroend

!macro customInit
  ; Ferme l'app si elle tourne, puis efface les vieux dossiers (sans lancer l'ancien désinstalleur).
  ExecWait 'taskkill /F /IM "DécoMiniCon.exe"'
  ExecWait 'taskkill /F /IM "decominicon.exe"'
  Sleep 500
  RMDir /r "$LOCALAPPDATA\Programs\DécoMiniCon"
  RMDir /r "$LOCALAPPDATA\Programs\decominicon"
!macroend

!macro customInstall
  FileOpen $0 "$INSTDIR\INSTALLE.txt" w
  FileWrite $0 "DécoMiniCon — installation OK$\r$\n"
  FileWrite $0 "Ouvrir : tape A N G E$\r$\n"
  FileClose $0
!macroend
