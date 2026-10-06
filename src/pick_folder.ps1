# The folder dialog snyvi shows on Windows (src/platform.rs, `pick_folder`).
#
# The daemon runs this in `powershell -STA -EncodedCommand` and reads one
# line: the folder chosen, or nothing for a cancel. `@TITLE@` is replaced
# with the dialog's title before it runs, quoted for a single-quoted string.
#
# The dialog is Explorer's own (`IFileOpenDialog` asked for folders): an
# address bar, search, Quick access, the folders the reader pinned. .NET
# Framework's FolderBrowserDialog -- the one Windows PowerShell has -- is the
# "Browse For Folder" tree from XP, and is only the fallback here, for a
# machine where the C# below cannot be compiled.
#
# Either one is owned by a form of this script's own -- topmost, invisible,
# with a taskbar button -- so it opens above snyvi and can always be found
# again. Coming to the front is the window's to allow: it calls
# `AllowSetForegroundWindow` just before it asks (src/bin/app.rs).

$ErrorActionPreference = 'Stop'
# The path goes back on stdout as UTF-8, whatever the console's code page:
# a folder named in Hindi or with an accent comes back as it is spelled.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$title = '@TITLE@'

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form -Property @{
  Text = $title; TopMost = $true; ShowInTaskbar = $true
  StartPosition = 'CenterScreen'; FormBorderStyle = 'None'
  Size = [System.Drawing.Size]::new(1, 1); Opacity = 0
}
$owner.Show(); $owner.Activate()

$picked = $null
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SnyviFolderDialog {
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    class FileOpenDialog {}

    // IFileDialog's vtable up to GetResult, in order; nothing after it is called.
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr specs);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(IntPtr bc, ref Guid handler, ref Guid iid, out IntPtr ppv);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    }

    const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
    const uint SIGDN_FILESYSPATH = 0x80058000;
    const int CANCELLED = unchecked((int)0x800704C7);

    // The folder chosen, or null for a cancel.
    public static string Pick(IntPtr owner, string title) {
        var d = (IFileDialog)new FileOpenDialog();
        try {
            uint o;
            d.GetOptions(out o);
            // Folders only, and only ones with a path: not Libraries, not
            // This PC, not a phone -- a desk needs somewhere to start.
            d.SetOptions(o | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            d.SetTitle(title);
            d.SetOkButtonLabel("Open");
            int hr = d.Show(owner);
            if (hr == CANCELLED) return null;
            Marshal.ThrowExceptionForHR(hr);
            IShellItem item;
            d.GetResult(out item);
            string path;
            item.GetDisplayName(SIGDN_FILESYSPATH, out path);
            return path;
        } finally {
            Marshal.ReleaseComObject(d);
        }
    }
}
'@
  $picked = [SnyviFolderDialog]::Pick($owner.Handle, $title)
} catch {
  # No compiler, a constrained language mode, a shell without the dialog:
  # the old dialog still answers the question.
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = $title; $d.ShowNewFolderButton = $false
  if ($d.ShowDialog($owner) -eq 'OK') { $picked = $d.SelectedPath }
}
$owner.Close()
if ($picked) { $picked }
