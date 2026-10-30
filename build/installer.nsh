; Look and wording of the Windows setup and uninstall screens: softer dark theme, plus a details list.
;
; electron-builder includes these macros at fixed places in its installer script:
;   customInstallMode         decides who the app is installed for (we skip that page: per-user only)
;   customWelcomePage         first page, before any other page is created (colours must be set here)
;   customFiles_x64           right after the program files are copied to the install folder
;   customInstall             after shortcuts and the uninstaller are written
;   customUnWelcomePage       first page of the uninstaller
;   customHeader              after all pages are created (global settings and helper functions)

!macro cinemaDarkDefines
  !define MUI_BGCOLOR "1D1F2A"
  !define MUI_TEXTCOLOR "F2F3F7"
  ; Details list on the "installing" page: soft grey text on the page colour.
  !define MUI_INSTFILESPAGE_COLORS "B4BAC8 1D1F2A"
  !define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!macroend

; Cinema is installed for the current user only (no administrator rights).
; Skipping the "who is this for" page keeps every page of the setup dark.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !insertmacro cinemaDarkDefines
  !define MUI_CUSTOMFUNCTION_GUIINIT cinemaGuiInit
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW cinemaInstFilesShow
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Cinema"
  !define MUI_WELCOMEPAGE_TEXT "Your private screening room.$\r$\n$\r$\nStream from your own server, save videos to watch offline, and keep your whole library in one place.$\r$\n$\r$\nClick Next to start. Cinema installs just for you and needs no administrator rights."
  !define MUI_FINISHPAGE_TITLE "Cinema is ready"
  !define MUI_FINISHPAGE_TEXT "Cinema has been installed on your computer.$\r$\n$\r$\nTip: press Ctrl+K inside the app to find anything quickly."
  !define MUI_FINISHPAGE_RUN_TEXT "Start Cinema now"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Show every step from here on (electron-builder switches the details off for the whole install section).
!macro customFiles_x64
  SetDetailsPrint both
  DetailPrint "Program files copied to $INSTDIR"
!macroend

!macro customInstall
  DetailPrint "Cinema is installed in $INSTDIR"
  DetailPrint "To remove it later: $INSTDIR\Uninstall Cinema.exe"
!macroend

!macro customUnWelcomePage
  !insertmacro cinemaDarkDefines
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.cinemaGuiInit
  !define MUI_UNCONFIRMPAGE_TEXT_TOP "Cinema will be removed from your computer. Your saved videos and settings are kept unless you delete them yourself."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customHeader
  ; Show the details list (what is being done) instead of only a bar.
  ShowInstDetails show
  ShowUninstDetails show

  !ifndef BUILD_UNINSTALLER
    ; The window around the pages (button bar, branding line) in the same colour.
    Function cinemaGuiInit
      SetCtlColors $HWNDPARENT "" "1D1F2A"
      GetDlgItem $0 $HWNDPARENT 1028
      SetCtlColors $0 "9BA3B4" "1D1F2A"
    FunctionEnd

    ; The "installing" page: page colour, light status text, and a flat teal progress bar.
    Function cinemaInstFilesShow
      SetCtlColors $mui.InstFilesPage "" "1D1F2A"
      SetCtlColors $mui.InstFilesPage.Text "F2F3F7" "1D1F2A"
      System::Call 'uxtheme::SetWindowTheme(p $mui.InstFilesPage.ProgressBar, w " ", w " ")'
      SendMessage $mui.InstFilesPage.ProgressBar 0x2001 0 3878186  ; track colour
      SendMessage $mui.InstFilesPage.ProgressBar 0x409 0 12571693  ; bar colour (teal)
    FunctionEnd
  !else
    Function un.cinemaGuiInit
      SetCtlColors $HWNDPARENT "" "1D1F2A"
      GetDlgItem $0 $HWNDPARENT 1028
      SetCtlColors $0 "9BA3B4" "1D1F2A"
    FunctionEnd
  !endif
!macroend
