; Look and wording of the Windows setup and uninstall screens (dark theme, with a details log).
;
; electron-builder includes these macros at fixed places in its installer script:
;   customWelcomePage         first page, before any other page is created (colours must be set here)
;   customPageAfterChangeDir  right before the "installing" page
;   customUnWelcomePage       first page of the uninstaller
;   customHeader              after all pages are created (global settings and helper functions)
;   customInstall             after the files are written

!macro cinemaDarkDefines
  !define MUI_BGCOLOR "0D0D12"
  !define MUI_TEXTCOLOR "E9EBF0"
  ; Colours of the details list and progress bar on the "installing" page: teal on near-black.
  !define MUI_INSTFILESPAGE_COLORS "2DD4BF 0D0D12"
  !define MUI_INSTFILESPAGE_PROGRESSBAR "colored"
!macroend

!macro customWelcomePage
  !insertmacro cinemaDarkDefines
  !define MUI_CUSTOMFUNCTION_GUIINIT cinemaGuiInit
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Cinema"
  !define MUI_WELCOMEPAGE_TEXT "Your private screening room.$\r$\n$\r$\nStream from your own server, save videos to watch offline, and keep your whole library in one place.$\r$\n$\r$\nClick Next to continue."
  !define MUI_FINISHPAGE_TITLE "Cinema is ready"
  !define MUI_FINISHPAGE_TEXT "Cinema has been installed on your computer.$\r$\n$\r$\nTip: press Ctrl+K inside the app to find anything quickly."
  !define MUI_FINISHPAGE_RUN_TEXT "Start Cinema now"
  !insertmacro MUI_PAGE_WELCOME
  ; applies to the next page that is created (the "where to install" page when it is shown)
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW cinemaDirShow
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW cinemaInstFilesShow
!macroend

!macro customUnWelcomePage
  !insertmacro cinemaDarkDefines
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.cinemaGuiInit
  !define MUI_UNCONFIRMPAGE_TEXT_TOP "Cinema will be removed from your computer. Your saved videos and settings are kept unless you delete them yourself."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customInstall
  DetailPrint "Cinema is installed in $INSTDIR"
  DetailPrint "To remove it later: $INSTDIR\Uninstall Cinema.exe"
!macroend

!macro customHeader
  ; Show the details list (what is being done) instead of only a bar.
  ShowInstDetails show
  ShowUninstDetails show

  !ifndef BUILD_UNINSTALLER
    ; The window around the pages (button bar, branding line) in dark too.
    Function cinemaGuiInit
      SetCtlColors $HWNDPARENT "" "0D0D12"
      GetDlgItem $0 $HWNDPARENT 1028
      SetCtlColors $0 "8A92A3" "0D0D12"
    FunctionEnd

    ; The "installing" page: dark background and light text for the status line.
    Function cinemaInstFilesShow
      SetCtlColors $mui.InstFilesPage "" "0D0D12"
      SetCtlColors $mui.InstFilesPage.Text "E9EBF0" "0D0D12"
    FunctionEnd

    ; The "where to install" page. Only touched when it really is that page.
    Function cinemaDirShow
      StrCmp $mui.DirectoryPage "" cinemaDirDone
      SetCtlColors $mui.DirectoryPage "" "0D0D12"
      SetCtlColors $mui.DirectoryPage.Text "E9EBF0" "0D0D12"
      SetCtlColors $mui.DirectoryPage.Directory "E9EBF0" "1A1A22"
      SetCtlColors $mui.DirectoryPage.SpaceRequired "B8BCC8" "0D0D12"
      SetCtlColors $mui.DirectoryPage.SpaceAvailable "B8BCC8" "0D0D12"
      cinemaDirDone:
    FunctionEnd
  !else
    Function un.cinemaGuiInit
      SetCtlColors $HWNDPARENT "" "0D0D12"
      GetDlgItem $0 $HWNDPARENT 1028
      SetCtlColors $0 "8A92A3" "0D0D12"
    FunctionEnd
  !endif
!macroend
