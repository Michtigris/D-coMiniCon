; Installeur NSIS DécoMiniCon — succès visible, pas de raccourci, lancement discret pour ANGE.

!macro customHeader
  !define MUI_FINISHPAGE_TITLE "Installation réussie"
  !define MUI_FINISHPAGE_TEXT "DécoMiniCon est bien installé sur ce PC.$\r$\n$\r$\nPour l'ouvrir : tape A N G E sur le clavier (à la suite, en moins de 4 secondes, sans autre touche).$\r$\n$\r$\nAucun raccourci bureau, aucun menu Démarrer, pas d'ouverture automatique à l'écran."
  !define MUI_FINISHPAGE_BUTTON "Terminer"
!macroend

!macro customInstall
  DetailPrint "Écriture du marqueur d'installation..."
  FileOpen $0 "$INSTDIR\INSTALLE.txt" w
  FileWrite $0 "DécoMiniCon — installation OK$\r$\n"
  FileWrite $0 "Pour ouvrir l'application : tape A N G E au clavier.$\r$\n"
  FileWrite $0 "Pas d'icone bureau / pas de raccourci.$\r$\n"
  FileClose $0

  DetailPrint "Démarrage discret (écoute ANGE, sans fenêtre)..."
  ; Pas de fenêtre visible : uniquement le listener clavier + icône éventuelle près de l'horloge.
  Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hidden'
!macroend
