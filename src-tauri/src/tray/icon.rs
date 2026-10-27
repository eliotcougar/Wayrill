//! Precompute status badges once; state changes reuse the rendered pixels.
use super::state::Shade;
use tauri::image::Image;

pub(super) struct Icons([Image<'static>; 5]);
impl Icons {
    pub fn new(base: &Image<'_>) -> Self {
        Self(
            [
                Shade::Offline,
                Shade::Stopped,
                Shade::Running,
                Shade::Busy,
                Shade::Failed,
            ]
            .map(|shade| badge(base, shade)),
        )
    }
    pub fn get(&self, shade: Shade) -> Image<'static> {
        self.0[match shade {
            Shade::Offline => 0,
            Shade::Stopped => 1,
            Shade::Running => 2,
            Shade::Busy => 3,
            Shade::Failed => 4,
        }]
        .clone()
    }
}
fn badge(base: &Image<'_>, shade: Shade) -> Image<'static> {
    let width = base.width();
    let height = base.height();
    let mut rgba = base.rgba().to_vec();
    let (color, glyph) = match shade {
        Shade::Running => ([32., 172., 108.], [0, 1, 18, 12, 0]), // check
        Shade::Stopped => ([100., 112., 126.], [31, 31, 31, 31, 31]), // stop
        Shade::Busy => ([216., 155., 32.], [0, 0, 21, 0, 0]),     // ellipsis
        Shade::Failed => ([218., 65., 72.], [4, 4, 4, 0, 4]),     // exclamation
        Shade::Offline => ([100., 112., 126.], [14, 17, 2, 0, 4]), // question
    };
    let size = width.min(height) as f32;
    let radius = size * 0.27;
    let cx = width as f32 - radius - 1.;
    let cy = height as f32 - radius - 1.;
    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let distance = dx.hypot(dy);
            let coverage = (radius + 0.5 - distance).clamp(0., 1.);
            if coverage == 0. {
                continue;
            }
            let mut fill = if distance > radius - size * 0.035 {
                [24., 32., 42.]
            } else {
                color
            };
            let gx = ((dx / radius + 0.65) / 0.26).floor() as i32;
            let gy = ((dy / radius + 0.65) / 0.26).floor() as i32;
            if (0..5).contains(&gx)
                && (0..5).contains(&gy)
                && glyph[gy as usize] & (1 << (4 - gx)) != 0
            {
                fill = [255., 255., 255.];
            }
            let pixel = &mut rgba[((y * width + x) * 4) as usize..][..4];
            let old_alpha = pixel[3] as f32 / 255.;
            let alpha = coverage + old_alpha * (1. - coverage);
            for c in 0..3 {
                pixel[c] = ((fill[c] * coverage + pixel[c] as f32 * old_alpha * (1. - coverage))
                    / alpha)
                    .round() as u8;
            }
            pixel[3] = (alpha * 255.).round() as u8;
        }
    }
    Image::new_owned(rgba, width, height)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn state_icons_are_distinct_and_preserve_the_logo_dimensions() {
        let base = Image::new_owned(vec![120; 32 * 32 * 4], 32, 32);
        let icons = Icons::new(&base);
        for (i, icon) in icons.0.iter().enumerate() {
            assert_eq!((icon.width(), icon.height()), (32, 32));
            assert_eq!(icon.rgba().len(), base.rgba().len());
            assert_eq!(&icon.rgba()[..4], &base.rgba()[..4]);
            for other in &icons.0[..i] {
                assert_ne!(icon.rgba(), other.rgba());
            }
        }
    }
}
