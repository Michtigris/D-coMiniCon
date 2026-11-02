; Installeur NSIS DécoMiniCon — remplace l'ancienne version, sans lancement furtif.

!include "LogicLib.nsh"

!macro customHeader
  !define MUI_WELCOMEPAGE_TITLE "Mettre à jour DécoMiniCon"
  !define MUI_WELCOMEPAGE_TEXT "Cet assistant va :$\r$\n$\r$\n1. Fermer DécoMiniCon s'il est ouvert$\r$\n2. Désinstaller l'ancienne version$\r$\n3. Installer la version ${VERSION}$\r$\n$\r$\nTes réglages (compte / position) sont conservés."
  !define MUI_FINISHPAGE_TITLE "Mise à jour réussie"
  !define MUI_FINISHPAGE_TEXT "DécoMiniCon ${VERSION} est installé.$\r$\n$\r$\nPour l'ouvrir : tape A N G E sur le clavier (à la suite, en moins de 4 secondes).$\r$\n$\r$\nAucun raccourci bureau."
  !define MUI_FINISHPAGE_BUTTON "Terminer"
!macroend

!macro customInit
  ; Ferme l'app si elle tourne (évite fichiers verrouillés).
  ExecWait 'taskkill /F /IM "DécoMiniCon.exe"'
  Sleep 800

  ; Désinstalle l'ancienne copie utilisateur si présente.
  StrCpy $R0 "$LOCALAPPDATA\Programs\DécoMiniCon"
  ${If} ${FileExists} "$R0\Uninstall DécoMiniCon.exe"
    DetailPrint "Désinstallation de l'ancienne version..."
    ExecWait '"$R0\Uninstall DécoMiniCon.exe" /S _?=$R0'
    Sleep 500
    RMDir /r "$R0"
  ${ElseIf} ${FileExists} "$R0\resources\app.asar"
    DetailPrint "Nettoyage de l'ancienne installation..."
    RMDir /r "$R0"
  ${EndIf}
!macroend

!macro customInstall
  DetailPrint "Écriture du marqueur d'installation..."
  FileOpen $0 "$INSTDIR\INSTALLE.txt" w
  FileWrite $0 "DécoMiniCon — installation OK$\r$\n"
  FileWrite $0 "Pour ouvrir l'application : tape A N G E au clavier.$\r$\n"
  FileWrite $0 "Pas d'icone bureau / pas de raccourci.$\r$\n"
  FileClose $0
  ; Pas d'Exec --hidden ici : ça déclenche souvent antivirus / Smart App Control.
!macroend
