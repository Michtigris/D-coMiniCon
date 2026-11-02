; Installeur NSIS DécoMiniCon — remplace l'ancienne version et relance l'app.

!include "LogicLib.nsh"

!macro customHeader
  !define MUI_WELCOMEPAGE_TITLE "Mettre à jour DécoMiniCon"
  !define MUI_WELCOMEPAGE_TEXT "Cet assistant va :$\r$\n$\r$\n1. Fermer DécoMiniCon s'il est ouvert$\r$\n2. Désinstaller l'ancienne version$\r$\n3. Installer la version ${VERSION}$\r$\n$\r$\nTes réglages (compte / position) sont conservés."
  !define MUI_FINISHPAGE_TITLE "Mise à jour réussie"
  !define MUI_FINISHPAGE_TEXT "DécoMiniCon ${VERSION} est installé et va s'ouvrir.$\r$\n$\r$\nEnsuite : tape A N G E pour le rappeler si tu le ranges."
  !define MUI_FINISHPAGE_BUTTON "Terminer"
!macroend

!macro RemoveOldInstall DIR
  ${If} ${FileExists} "${DIR}\Uninstall DécoMiniCon.exe"
    ExecWait '"${DIR}\Uninstall DécoMiniCon.exe" /S _?=${DIR}'
    Sleep 400
    RMDir /r "${DIR}"
  ${ElseIf} ${FileExists} "${DIR}\Uninstall decominicon.exe"
    ExecWait '"${DIR}\Uninstall decominicon.exe" /S _?=${DIR}'
    Sleep 400
    RMDir /r "${DIR}"
  ${ElseIf} ${FileExists} "${DIR}\resources\app.asar"
    RMDir /r "${DIR}"
  ${EndIf}
!macroend

!macro customInit
  ExecWait 'taskkill /F /IM "DécoMiniCon.exe"'
  ExecWait 'taskkill /F /IM "decominicon.exe"'
  Sleep 800

  ; Anciennes installs (nom produit ou nom package).
  !insertmacro RemoveOldInstall "$LOCALAPPDATA\Programs\DécoMiniCon"
  !insertmacro RemoveOldInstall "$LOCALAPPDATA\Programs\decominicon"
!macroend

!macro customInstall
  DetailPrint "Écriture du marqueur d'installation..."
  FileOpen $0 "$INSTDIR\INSTALLE.txt" w
  FileWrite $0 "DécoMiniCon — installation OK$\r$\n"
  FileWrite $0 "Pour ouvrir : tape A N G E au clavier.$\r$\n"
  FileClose $0

  ; Ouvre l'app normalement (visible) — pas --hidden.
  DetailPrint "Lancement de DécoMiniCon..."
  Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
!macroend
