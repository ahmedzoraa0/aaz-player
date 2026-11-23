use tauri::WebviewWindow;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskbarMediaState {
    pub has_media: bool,
    pub is_playing: bool,
    pub can_prev: bool,
    pub can_next: bool,
    pub is_arabic: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconGlyph {
    Prev,
    Play,
    Pause,
    Next,
}

pub const ICON_DIM: usize = 24;

pub fn encode_utf16_tooltip(text: &str) -> [u16; 260] {
    let mut buf = [0u16; 260];
    for (i, unit) in text.encode_utf16().take(259).enumerate() {
        buf[i] = unit;
    }
    buf
}

pub fn tooltips_for_state(state: &TaskbarMediaState) -> (&'static str, &'static str, &'static str) {
    if state.is_arabic {
        let play_tip = if state.is_playing {
            "إيقاف مؤقت"
        } else {
            "تشغيل"
        };
        ("المقطع السابق", play_tip, "المقطع التالي")
    } else {
        let play_tip = if state.is_playing { "Pause" } else { "Play" };
        ("Previous Track", play_tip, "Next Track")
    }
}

/// Renders a crisp 24x24 32-bit BGRA icon buffer for Windows taskbar thumbnail buttons.
pub fn render_glyph_bgra(glyph: IconGlyph) -> Vec<u8> {
    let mut bgra = vec![0u8; ICON_DIM * ICON_DIM * 4];

    let mut set_px = |x: usize, y: usize, b: u8, g: u8, r: u8, a: u8| {
        if x < ICON_DIM && y < ICON_DIM {
            let idx = (y * ICON_DIM + x) * 4;
            bgra[idx] = b;
            bgra[idx + 1] = g;
            bgra[idx + 2] = r;
            bgra[idx + 3] = a;
        }
    };

    // High-contrast crisp off-white glyph with subtle AAZ mint tint for visibility on dark/light taskbar flyouts
    let (fg_b, fg_g, fg_r, fg_a) = (0xF1u8, 0xF7u8, 0xEEu8, 0xFFu8);

    match glyph {
        IconGlyph::Play => {
            // Centered right-pointing triangle (x: 7..=18, y: 5..=18)
            for y in 5..=18 {
                let dist = (y as isize - 11).abs().max((y as isize - 12).abs());
                let span = (7 - dist).max(0) as usize;
                let max_x = 7 + span * 11 / 7;
                for x in 7..=max_x {
                    set_px(x, y, fg_b, fg_g, fg_r, fg_a);
                }
            }
        }
        IconGlyph::Pause => {
            // Two vertical rounded-looking bars
            for y in 5..=18 {
                for x in 6..=10 {
                    set_px(x, y, fg_b, fg_g, fg_r, fg_a);
                }
                for x in 14..=18 {
                    set_px(x, y, fg_b, fg_g, fg_r, fg_a);
                }
            }
        }
        IconGlyph::Prev => {
            // Left vertical bar (x: 5..=7) + left-pointing triangle (x: 9..=18)
            for y in 6..=17 {
                for x in 5..=7 {
                    set_px(x, y, fg_b, fg_g, fg_r, fg_a);
                }
                let dist = (y as isize - 11).abs().max((y as isize - 12).abs());
                let span = (6 - dist).max(0) as usize;
                let min_x = 18usize.saturating_sub(span * 9 / 6);
                for x in min_x..=18 {
                    set_px(x, y, fg_b, fg_g, fg_r, fg_a);
                }
            }
        }
        IconGlyph::Next => {
            // Right-pointing triangle (x: 5..=14) + right vertical bar (x: 16..=18)
            for y in 6..=17 {
                let dist = (y as isize - 11).abs().max((y as isize - 12).abs());
                let span = (6 - dist).max(0) as usize;
                let max_x = 5 + span * 9 / 6;
                for x in 5..=max_x {
                    set_px(x, y, fg_b, fg_g, fg_r, fg_a);
                }
                for x in 16..=18 {
                    set_px(x, y, fg_b, fg_g, fg_r, fg_a);
                }
            }
        }
    }

    bgra
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        encode_utf16_tooltip, render_glyph_bgra, tooltips_for_state, IconGlyph, TaskbarMediaState,
        ICON_DIM,
    };
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};
    use tauri::{Emitter, WebviewWindow};
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, TRUE, WPARAM};
    use windows::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject, HGDIOBJ};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        DefSubclassProc, ITaskbarList3, RemoveWindowSubclass, SetWindowSubclass, TaskbarList,
        THBF_DISABLED, THBF_ENABLED, THBN_CLICKED, THB_FLAGS, THB_ICON, THB_TOOLTIP, THUMBBUTTON,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIconIndirect, DestroyIcon, RegisterWindowMessageW, HICON, ICONINFO, WM_COMMAND,
        WM_NCDESTROY,
    };

    const SUBCLASS_ID: usize = 0xAA27_1700;
    const BTN_PREV: u32 = 1001;
    const BTN_PLAY_PAUSE: u32 = 1002;
    const BTN_NEXT: u32 = 1003;

    struct OwnedIcon(HICON);

    impl Drop for OwnedIcon {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyIcon(self.0);
            }
        }
    }

    struct IconSet {
        prev: OwnedIcon,
        play: OwnedIcon,
        pause: OwnedIcon,
        next: OwnedIcon,
    }

    struct SubclassContext {
        label: String,
        window: WebviewWindow,
        taskbar_created_msg: u32,
        com_initialized: bool,
        taskbar: Option<ITaskbarList3>,
        buttons_added: bool,
        icons: IconSet,
        state: TaskbarMediaState,
    }

    impl Drop for SubclassContext {
        fn drop(&mut self) {
            self.taskbar = None;
            if self.com_initialized {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    static WINDOW_STATES: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();

    fn registry() -> &'static Mutex<HashMap<String, usize>> {
        WINDOW_STATES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn create_hicon(glyph: IconGlyph) -> Option<OwnedIcon> {
        let bgra = render_glyph_bgra(glyph);
        // 1-bpp monochrome AND mask (all 0s so alpha channel from 32-bit BGRA controls transparency)
        let mask_stride = ICON_DIM.div_ceil(16) * 2;
        let mask = vec![0u8; mask_stride * ICON_DIM];

        unsafe {
            let hbm_color = CreateBitmap(
                ICON_DIM as i32,
                ICON_DIM as i32,
                1,
                32,
                Some(bgra.as_ptr().cast::<c_void>()),
            );
            if hbm_color.is_invalid() {
                return None;
            }
            let hbm_mask = CreateBitmap(
                ICON_DIM as i32,
                ICON_DIM as i32,
                1,
                1,
                Some(mask.as_ptr().cast::<c_void>()),
            );
            if hbm_mask.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(hbm_color.0));
                return None;
            }

            let info = ICONINFO {
                fIcon: TRUE,
                xHotspot: 0,
                yHotspot: 0,
                hbmMask: hbm_mask,
                hbmColor: hbm_color,
            };

            let icon = CreateIconIndirect(&info).ok().map(OwnedIcon);
            let _ = DeleteObject(HGDIOBJ(hbm_mask.0));
            let _ = DeleteObject(HGDIOBJ(hbm_color.0));
            icon
        }
    }

    fn build_icon_set() -> Option<IconSet> {
        Some(IconSet {
            prev: create_hicon(IconGlyph::Prev)?,
            play: create_hicon(IconGlyph::Play)?,
            pause: create_hicon(IconGlyph::Pause)?,
            next: create_hicon(IconGlyph::Next)?,
        })
    }

    fn build_buttons(ctx: &SubclassContext) -> [THUMBBUTTON; 3] {
        let (prev_tip, play_tip, next_tip) = tooltips_for_state(&ctx.state);
        let mask = THB_ICON | THB_TOOLTIP | THB_FLAGS;

        let prev_flags = if ctx.state.has_media && ctx.state.can_prev {
            THBF_ENABLED
        } else {
            THBF_DISABLED
        };
        let play_flags = if ctx.state.has_media {
            THBF_ENABLED
        } else {
            THBF_DISABLED
        };
        let next_flags = if ctx.state.has_media && ctx.state.can_next {
            THBF_ENABLED
        } else {
            THBF_DISABLED
        };

        let play_icon = if ctx.state.is_playing {
            ctx.icons.pause.0
        } else {
            ctx.icons.play.0
        };

        [
            THUMBBUTTON {
                dwMask: mask,
                iId: BTN_PREV,
                iBitmap: 0,
                hIcon: ctx.icons.prev.0,
                szTip: encode_utf16_tooltip(prev_tip),
                dwFlags: prev_flags,
            },
            THUMBBUTTON {
                dwMask: mask,
                iId: BTN_PLAY_PAUSE,
                iBitmap: 0,
                hIcon: play_icon,
                szTip: encode_utf16_tooltip(play_tip),
                dwFlags: play_flags,
            },
            THUMBBUTTON {
                dwMask: mask,
                iId: BTN_NEXT,
                iBitmap: 0,
                hIcon: ctx.icons.next.0,
                szTip: encode_utf16_tooltip(next_tip),
                dwFlags: next_flags,
            },
        ]
    }

    unsafe fn ensure_taskbar_instance(ctx: &mut SubclassContext) -> bool {
        if ctx.taskbar.is_none() {
            if !ctx.com_initialized {
                let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                if hr.is_ok() {
                    ctx.com_initialized = true;
                }
            }
            let res: windows::core::Result<ITaskbarList3> =
                CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER);
            if let Ok(tb) = res {
                if tb.HrInit().is_ok() {
                    ctx.taskbar = Some(tb);
                }
            }
        }
        ctx.taskbar.is_some()
    }

    unsafe fn apply_buttons(hwnd: HWND, ctx: &mut SubclassContext) {
        if !ensure_taskbar_instance(ctx) {
            return;
        }
        let buttons = build_buttons(ctx);
        if let Some(ref tb) = ctx.taskbar {
            if !ctx.buttons_added {
                if tb.ThumbBarAddButtons(hwnd, &buttons).is_ok() {
                    ctx.buttons_added = true;
                }
            } else if tb.ThumbBarUpdateButtons(hwnd, &buttons).is_err() {
                ctx.buttons_added = false;
                if tb.ThumbBarAddButtons(hwnd, &buttons).is_ok() {
                    ctx.buttons_added = true;
                }
            }
        }
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        umsg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _uidsubclass: usize,
        dwrefdata: usize,
    ) -> LRESULT {
        if dwrefdata == 0 {
            return DefSubclassProc(hwnd, umsg, wparam, lparam);
        }

        if umsg == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
            let ctx = Box::from_raw(dwrefdata as *mut SubclassContext);
            if let Ok(mut map) = registry().lock() {
                map.remove(&ctx.label);
            }
            drop(ctx);
            return DefSubclassProc(hwnd, umsg, wparam, lparam);
        }

        let ctx = &mut *(dwrefdata as *mut SubclassContext);

        if ctx.taskbar_created_msg != 0 && umsg == ctx.taskbar_created_msg {
            // Re-create thumbnail buttons when Windows creates or restarts Explorer taskbar
            ctx.taskbar = None;
            ctx.buttons_added = false;
            apply_buttons(hwnd, ctx);
        } else if umsg == WM_COMMAND {
            let hiword = ((wparam.0 >> 16) & 0xFFFF) as u32;
            let loword = (wparam.0 & 0xFFFF) as u32;
            if hiword == THBN_CLICKED {
                let action = match loword {
                    BTN_PREV => Some("prev"),
                    BTN_PLAY_PAUSE => Some("toggle-play"),
                    BTN_NEXT => Some("next"),
                    _ => None,
                };
                if let Some(act) = action {
                    let _ = ctx.window.emit_to(&ctx.label, "aaz:taskbar-action", act);
                    return LRESULT(0);
                }
            }
        }

        DefSubclassProc(hwnd, umsg, wparam, lparam)
    }

    pub fn attach_to_window(window: &WebviewWindow) {
        let win_clone = window.clone();
        let _ = window.run_on_main_thread(move || {
            let label = win_clone.label().to_string();
            if let Ok(map) = registry().lock() {
                if map.contains_key(&label) {
                    return;
                }
            }
            let Ok(raw_hwnd) = win_clone.hwnd() else {
                return;
            };
            let hwnd = HWND(raw_hwnd.0 as usize as *mut c_void);
            let Some(icons) = build_icon_set() else {
                return;
            };
            let taskbar_created_msg = unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) };

            let ctx = Box::new(SubclassContext {
                label: label.clone(),
                window: win_clone.clone(),
                taskbar_created_msg,
                com_initialized: false,
                taskbar: None,
                buttons_added: false,
                icons,
                state: TaskbarMediaState::default(),
            });
            let ctx_ptr = Box::into_raw(ctx);

            let ok = unsafe {
                SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, ctx_ptr as usize)
                    .as_bool()
            };
            if !ok {
                unsafe {
                    drop(Box::from_raw(ctx_ptr));
                }
                return;
            }

            if let Ok(mut map) = registry().lock() {
                map.insert(label, ctx_ptr as usize);
            }

            // Attempt immediate registration in case TaskbarButtonCreated already fired before attach
            unsafe {
                apply_buttons(hwnd, &mut *ctx_ptr);
            }
        });
    }

    pub fn update_window_state(window: &WebviewWindow, next_state: TaskbarMediaState) {
        let win_clone = window.clone();
        let _ = window.run_on_main_thread(move || {
            let label = win_clone.label().to_string();
            let ptr_opt = registry()
                .lock()
                .ok()
                .and_then(|map| map.get(&label).copied());
            let Some(ptr) = ptr_opt else {
                return;
            };
            let Ok(raw_hwnd) = win_clone.hwnd() else {
                return;
            };
            let hwnd = HWND(raw_hwnd.0 as usize as *mut c_void);
            unsafe {
                let ctx = &mut *(ptr as *mut SubclassContext);
                ctx.state = next_state;
                apply_buttons(hwnd, ctx);
            }
        });
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::TaskbarMediaState;
    use tauri::WebviewWindow;

    pub fn attach_to_window(_window: &WebviewWindow) {}

    pub fn update_window_state(_window: &WebviewWindow, _next_state: TaskbarMediaState) {}
}

pub fn attach_taskbar_controls(window: &WebviewWindow) {
    imp::attach_to_window(window);
}

pub fn update_taskbar_state(window: &WebviewWindow, state: TaskbarMediaState) {
    imp::update_window_state(window, state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_utf16_tooltips_with_null_termination() {
        let en = encode_utf16_tooltip("Play");
        assert_eq!(en[0], b'P' as u16);
        assert_eq!(en[3], b'y' as u16);
        assert_eq!(en[4], 0);

        let long = "a".repeat(300);
        let truncated = encode_utf16_tooltip(&long);
        assert_eq!(truncated[258], b'a' as u16);
        assert_eq!(truncated[259], 0);
    }

    #[test]
    fn bilingual_tooltips_reflect_playback_state() {
        let paused_en = TaskbarMediaState {
            has_media: true,
            is_playing: false,
            can_prev: true,
            can_next: true,
            is_arabic: false,
        };
        assert_eq!(
            tooltips_for_state(&paused_en),
            ("Previous Track", "Play", "Next Track")
        );

        let playing_ar = TaskbarMediaState {
            has_media: true,
            is_playing: true,
            can_prev: true,
            can_next: true,
            is_arabic: true,
        };
        assert_eq!(
            tooltips_for_state(&playing_ar),
            ("المقطع السابق", "إيقاف مؤقت", "المقطع التالي")
        );
    }

    #[test]
    fn renders_non_empty_bgra_glyph_buffers() {
        for glyph in [
            IconGlyph::Prev,
            IconGlyph::Play,
            IconGlyph::Pause,
            IconGlyph::Next,
        ] {
            let buf = render_glyph_bgra(glyph);
            assert_eq!(buf.len(), ICON_DIM * ICON_DIM * 4);
            let opaque_pixels = buf.chunks_exact(4).filter(|px| px[3] == 0xFF).count();
            assert!(
                opaque_pixels > 20,
                "glyph {:?} should draw visible pixels",
                glyph
            );
        }
    }
}
