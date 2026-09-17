; The Windows installer: one file to double-click, and snyvi is in the Start
; menu, on PATH and connected to Claude Code.
;
;   packaging/windows.ps1 <version>     builds it; see that file
;
; The zip asked for five steps before anything opened -- choose a folder,
; unzip, open a terminal there, `install-cli`, open another terminal -- and
; every one of them was a place to stop. This does the same things in the
; same order and asks nothing but whether to go on.
;
; For one user, never for the machine. `{localappdata}\Programs` is where
; Windows itself puts a per-user program, it needs no administrator, and so
; there is no UAC prompt -- only SmartScreen, once, because the executables
; are not signed. Not `%LOCALAPPDATA%\snyvi`: that is the library, and an
; uninstall that deletes its own folder must never be pointed at the reader's
; documents.
;
; Inno Setup rather than tauri's bundler: the bundler builds around one
; executable and this is two, it would want the tauri CLI built on every
; release, and PATH is the step the zip was missing -- which here is twenty
; lines below that anyone can read.

#ifndef Version
  #error pass the version: iscc /DVersion=1.2.3 packaging\windows.iss
#endif
#ifndef Bin
  #define Bin SourcePath + "..\target\release"
#endif

[Setup]
; Fixed forever: this is how an upgrade finds the install it replaces.
AppId={{77914D41-28F1-4AB8-AA82-692BB637B9B2}
AppName=snyvi
AppVersion={#Version}
AppVerName=snyvi {#Version}
AppPublisher=snymrova
AppPublisherURL=https://mrova.rocks/snyvi
AppSupportURL=https://github.com/snymrova/snyvi/issues
DefaultDirName={localappdata}\Programs\snyvi
PrivilegesRequired=lowest
; Every page that is a question with one right answer is left out: the
; folder, the Start menu group, the summary before installing.
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; WebView2, which the window uses, is part of Windows from 10 on.
MinVersion=10.0
WizardStyle=modern
SetupIconFile={#SourcePath}..\icons\icon.ico
UninstallDisplayIcon={app}\snyvi-app.exe
UninstallDisplayName=snyvi
OutputDir={#SourcePath}..\dist
OutputBaseFilename=snyvi-{#Version}-x86_64-pc-windows-msvc-setup
Compression=lzma2
SolidCompression=yes
; Tells running programs PATH changed, so a terminal opened after the
; install finds `snyvi` without signing out.
ChangesEnvironment=yes
; An upgrade over a running snyvi: the daemon and the window hold their
; executables open. PrepareToInstall below stops both politely; this is for
; whatever that missed.
CloseApplications=force
RestartApplications=no

[Tasks]
Name: claude; Description: "Connect Claude Code, if it is installed (snyvi init-claude)"
Name: desktopicon; Description: "{cm:CreateDesktopIcon}"; Flags: unchecked

[Files]
Source: "{#Bin}\snyvi.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Bin}\snyvi-app.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; The window with no argument hands over to the snyvi.exe beside it, which
; starts the daemon if it is not up and comes back with the viewer.
Name: "{autoprograms}\snyvi"; Filename: "{app}\snyvi-app.exe"
Name: "{autodesktop}\snyvi"; Filename: "{app}\snyvi-app.exe"; Tasks: desktopicon

[Run]
; Safe to run again, so an upgrade that keeps the box ticked changes nothing.
; Without `claude` on PATH it says so and exits, and the install goes on.
Filename: "{app}\snyvi.exe"; Parameters: "init-claude"; Tasks: claude; \
  Flags: runhidden; StatusMsg: "Connecting Claude Code..."
Filename: "{app}\snyvi-app.exe"; Description: "Open snyvi"; \
  Flags: nowait postinstall skipifsilent

[UninstallRun]
; The registration points at the snyvi.exe about to be deleted, and a
; registration of a program that is gone is an error in every Claude session.
; The documents are not touched; only `snyvi reset` does that.
Filename: "{app}\snyvi.exe"; Parameters: "uninstall-claude"; Flags: runhidden; \
  RunOnceId: "UninstallClaude"
Filename: "{app}\snyvi.exe"; Parameters: "stop"; Flags: runhidden; RunOnceId: "StopDaemon"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM snyvi-app.exe"; Flags: runhidden; \
  RunOnceId: "CloseWindow"

[Code]
const
  EnvKey = 'Environment';

// PATH is compared as Windows compares it: without case, one entry at a
// time, so C:\x\snyvi does not match inside C:\x\snyvi-old.
function PathHas(Paths, Dir: string): Boolean;
begin
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';') > 0;
end;

// The user's PATH, not the machine's: no administrator, and the same key
// `snyvi install-cli` writes, so a reader who used the zip first ends up with
// one entry each and not a conflict. Written as REG_EXPAND_SZ because that is
// what Windows keeps it as; a REG_SZ here would stop %USERPROFILE% in someone
// else's entry from expanding.
procedure AddToPath(Dir: string);
var
  Paths: string;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then
    Paths := '';
  if PathHas(Paths, Dir) then
    exit;
  if (Paths <> '') and (Copy(Paths, Length(Paths), 1) <> ';') then
    Paths := Paths + ';';
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Paths + Dir);
end;

procedure RemoveFromPath(Dir: string);
var
  Paths: string;
  P: Integer;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', Paths) then
    exit;
  Paths := ';' + Paths + ';';
  P := Pos(';' + Uppercase(Dir) + ';', Uppercase(Paths));
  if P = 0 then
    exit;
  Delete(Paths, P, Length(Dir) + 1);
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', Copy(Paths, 2, Length(Paths) - 2));
end;

// Before any file is replaced: an upgrade over a running daemon would find
// snyvi.exe locked, and the new window would talk to the old daemon.
// `snyvi stop` is the same command the reader would type; it waits for the
// port to close. Neither failing is a reason not to install.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  if FileExists(ExpandConstant('{app}\snyvi.exe')) then
    Exec(ExpandConstant('{app}\snyvi.exe'), 'stop', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM snyvi-app.exe', '', SW_HIDE,
    ewWaitUntilTerminated, Code);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    AddToPath(ExpandConstant('{app}'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveFromPath(ExpandConstant('{app}'));
end;
