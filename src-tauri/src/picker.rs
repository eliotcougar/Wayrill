//! Native choices run as the desktop user. The service never receives picker paths.
use windows::{
    core::{w, HRESULT},
    Win32::{
        Foundation::{ERROR_CANCELLED, HWND},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{
            Common::COMDLG_FILTERSPEC, FileOpenDialog, IFileOpenDialog, FOS_FILEMUSTEXIST,
            FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
        },
    },
};

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub fn choose(owner: usize, mode: &str) -> Result<Option<String>, String> {
    if !["name", "path", "folder", "routing"].contains(&mode) {
        return Err("Invalid file picker mode.".into());
    }
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        let _apartment = Apartment;
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| e.to_string())?;
        let options = FOS_FORCEFILESYSTEM
            | FOS_PATHMUSTEXIST
            | if mode == "folder" {
                FOS_PICKFOLDERS
            } else {
                FOS_FILEMUSTEXIST
            };
        dialog.SetOptions(options).map_err(|e| e.to_string())?;
        if mode == "folder" {
            dialog
                .SetTitle(w!("Select application folder — Wayrill"))
                .map_err(|e| e.to_string())?;
        } else if mode == "routing" {
            dialog
                .SetTitle(w!("Select routing file — Wayrill"))
                .map_err(|e| e.to_string())?;
            dialog
                .SetFileTypes(&[
                    COMDLG_FILTERSPEC {
                        pszName: w!("Routing files (*.json;*.jsonc;*.txt)"),
                        pszSpec: w!("*.json;*.jsonc;*.txt"),
                    },
                    COMDLG_FILTERSPEC {
                        pszName: w!("All files"),
                        pszSpec: w!("*.*"),
                    },
                ])
                .map_err(|e| e.to_string())?;
        } else {
            dialog
                .SetTitle(w!("Select executable — Wayrill"))
                .map_err(|e| e.to_string())?;
            dialog
                .SetFileTypes(&[COMDLG_FILTERSPEC {
                    pszName: w!("Windows executables (*.exe)"),
                    pszSpec: w!("*.exe"),
                }])
                .map_err(|e| e.to_string())?;
        }
        match dialog.Show(Some(HWND(owner as *mut _))) {
            Err(e) if e.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => return Ok(None),
            Err(e) => return Err(e.to_string()),
            Ok(()) => {}
        }
        let item = dialog.GetResult().map_err(|e| e.to_string())?;
        let raw = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|e| e.to_string())?;
        let text = raw.to_string();
        CoTaskMemFree(Some(raw.0.cast()));
        let path = text.map_err(|e| e.to_string())?;
        if mode != "folder"
            && mode != "routing"
            && !std::path::Path::new(&path)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        {
            return Err("Choose a Windows executable (.exe).".into());
        }
        Ok(Some(if mode == "name" {
            std::path::Path::new(&path)
                .file_name()
                .ok_or("Invalid executable path.")?
                .to_string_lossy()
                .into_owned()
        } else {
            path
        }))
    }
}
