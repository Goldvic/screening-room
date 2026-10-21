; Look and wording of the Windows setup and uninstall screens.
!macro customHeader
  ; Dark header, welcome page and finish page, with light text.
  !ifndef MUI_BGCOLOR
    !define MUI_BGCOLOR "0D0D12"
  !endif
  !ifndef MUI_TEXTCOLOR
    !define MUI_TEXTCOLOR "FFFFFF"
  !endif
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Cinema"
  !define MUI_WELCOMEPAGE_TEXT "Your private screening room.$\r$\n$\r$\nStream from your own server, save videos to watch offline, and keep your whole library in one place.$\r$\n$\r$\nClick Next to continue."
  !define MUI_FINISHPAGE_TITLE "Cinema is ready"
  !define MUI_FINISHPAGE_TEXT "Cinema has been installed on your computer.$\r$\n$\r$\nTip: press Ctrl+K inside the app to find anything quickly."
  !define MUI_FINISHPAGE_RUN_TEXT "Start Cinema now"
  !define MUI_UNCONFIRMPAGE_TEXT_TOP "Cinema will be removed from your computer. Your saved videos and settings are kept unless you delete them yourself."
!macroend
