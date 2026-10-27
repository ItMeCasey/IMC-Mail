; Extra steps for the Windows installer (included by electron-builder through nsis.include).
;
; 1. IMC-Mail appears in Settings > Apps > Default apps > Email (and handles mailto: links once chosen there). Windows does
;    not let a program make itself the default; it lists programs registered like this and the person picks one.
; 2. Right-clicking a file in Explorer offers "Mail this", which opens a new message with that file attached.
;
; SHCTX is the current user's part of the registry for a per-user install, or the machine's part for an all-users install.

!macro customInstall
  ; --- an email program Windows can list ---
  WriteRegStr SHCTX "Software\Clients\Mail\IMC-Mail" "" "IMC-Mail"
  WriteRegStr SHCTX "Software\Clients\Mail\IMC-Mail\Capabilities" "ApplicationName" "IMC-Mail"
  WriteRegStr SHCTX "Software\Clients\Mail\IMC-Mail\Capabilities" "ApplicationDescription" "Email for streamers and content creators"
  WriteRegStr SHCTX "Software\Clients\Mail\IMC-Mail\Capabilities\UrlAssociations" "mailto" "IMC-Mail.Url.mailto"
  WriteRegStr SHCTX "Software\Clients\Mail\IMC-Mail\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Clients\Mail\IMC-Mail\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr SHCTX "Software\RegisteredApplications" "IMC-Mail" "Software\Clients\Mail\IMC-Mail\Capabilities"

  ; --- what happens when a mail link is clicked ---
  WriteRegStr SHCTX "Software\Classes\IMC-Mail.Url.mailto" "" "URL:MailTo"
  WriteRegStr SHCTX "Software\Classes\IMC-Mail.Url.mailto" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\IMC-Mail.Url.mailto\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\IMC-Mail.Url.mailto\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; --- right-click a file: "Mail this" ---
  WriteRegStr SHCTX "Software\Classes\*\shell\IMC-Mail.MailThis" "" "Mail this"
  WriteRegStr SHCTX "Software\Classes\*\shell\IMC-Mail.MailThis" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\*\shell\IMC-Mail.MailThis\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --attach "%1"'
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\RegisteredApplications" "IMC-Mail"
  DeleteRegKey SHCTX "Software\Clients\Mail\IMC-Mail"
  DeleteRegKey SHCTX "Software\Classes\IMC-Mail.Url.mailto"
  DeleteRegKey SHCTX "Software\Classes\*\shell\IMC-Mail.MailThis"
!macroend
