!macro customInstall
  WriteRegStr HKCU "Software\Classes\mindweaver" "" "URL:MindWeaver"
  WriteRegStr HKCU "Software\Classes\mindweaver" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\mindweaver\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\mindweaver\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\mindweaver"
!macroend
