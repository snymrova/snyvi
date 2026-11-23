//! What is done to a take before the model hears it: is it loud enough, where
//! is the spoken part, and how much to lift it.
//!
//! All three come from takes of a real voice on a weak microphone. Given the
//! whole take, quiet and unlifted, the model returned nothing, or one phrase
//! twice; cut to the spoken part and lifted, it heard the phrase. And a take
//! with nothing in it must never reach the model at all, since a model asked
//! to hear a room will sometimes answer with a word.
//!
//! Nothing here knows about the model, so all of it is tested without one.

use std::ops::Range;

/// Under this peak a take is "too quiet": said back to the reader, never
/// guessed at. A microphone at half volume across a desk peaked at 0.07 with
/// a voice in it; an open one in a quiet room stays well under this.
pub const QUIET: f32 = 0.02;

/// The longest take kept, in seconds. A command is two; this is room for a
/// slow one, and a bound on what a held key can make the helper hold.
pub const LONGEST_S: usize = 20;

/// Speech shorter than this is a click or a cough's edge, not a word.
const SHORTEST_MS: usize = 150;

/// Kept either side of the spoken part, so a soft first consonant survives.
const PAD_MS: usize = 200;

/// A frame counts as spoken at this share of the loudest frame's level.
const SPOKEN_SHARE: f32 = 0.15;

/// The lift aims the peak here, and never multiplies by more than `MOST`:
/// past that it is the room being lifted, not the voice.
const LIFT_TO: f32 = 0.9;
const MOST: f32 = 30.0;

/// The loudest sample, as a share of full scale.
pub fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |m, s| m.max(s.abs()))
}

/// Where the spoken part is, padded, or `None` when there is none worth a
/// decode. Level is measured in 20 ms frames against the take's own loudest
/// frame, so it holds for a near microphone and a far one alike.
pub fn spoken(samples: &[f32], rate: u32) -> Option<Range<usize>> {
    let frame = (rate as usize / 50).max(1);
    let levels: Vec<f32> = samples
        .chunks(frame)
        .map(|f| (f.iter().map(|s| s * s).sum::<f32>() / f.len() as f32).sqrt())
        .collect();
    let loudest = levels.iter().fold(0.0f32, |m, l| m.max(*l));
    if loudest <= 0.0 {
        return None;
    }
    let bar = loudest * SPOKEN_SHARE;
    let first = levels.iter().position(|l| *l >= bar)?;
    let last = levels.iter().rposition(|l| *l >= bar)?;
    if (last + 1 - first) * 20 < SHORTEST_MS {
        return None;
    }
    let pad = rate as usize * PAD_MS / 1000;
    let start = (first * frame).saturating_sub(pad);
    let end = ((last + 1) * frame + pad).min(samples.len());
    Some(start..end)
}

/// The same sound with its peak at `LIFT_TO`. A loud take is brought down by
/// the same rule, which costs nothing and keeps one path.
pub fn lift(samples: &[f32]) -> Vec<f32> {
    let p = peak(samples);
    if p <= 0.0 {
        return samples.to_vec();
    }
    let by = (LIFT_TO / p).min(MOST);
    samples.iter().map(|s| s * by).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 16_000;

    /// `ms` of a 220 Hz tone at `level`.
    fn tone(ms: usize, level: f32) -> Vec<f32> {
        (0..RATE as usize * ms / 1000)
            .map(|i| level * (i as f32 * 220.0 * std::f32::consts::TAU / RATE as f32).sin())
            .collect()
    }

    fn quiet(ms: usize) -> Vec<f32> {
        vec![0.0; RATE as usize * ms / 1000]
    }

    #[test]
    fn the_peak_is_the_loudest_sample_either_way_up() {
        assert_eq!(peak(&[0.1, -0.6, 0.3]), 0.6);
        assert_eq!(peak(&[]), 0.0);
    }

    #[test]
    fn the_spoken_part_is_found_with_its_padding() {
        let take = [quiet(1000), tone(600, 0.3), quiet(1000)].concat();
        let r = spoken(&take, RATE).expect("a tone of 600 ms is spoken");
        // 200 ms either side of 1000..1600 ms, to the frame.
        assert_eq!(r.start, 800 * 16);
        assert_eq!(r.end, 1800 * 16);
    }

    #[test]
    fn padding_stops_at_the_ends_of_the_take() {
        let take = tone(400, 0.3);
        assert_eq!(spoken(&take, RATE), Some(0..take.len()));
    }

    #[test]
    fn a_click_is_not_speech() {
        let take = [quiet(500), tone(60, 0.5), quiet(500)].concat();
        assert_eq!(spoken(&take, RATE), None);
    }

    #[test]
    fn nothing_at_all_is_not_speech() {
        assert_eq!(spoken(&quiet(800), RATE), None);
        assert_eq!(spoken(&[], RATE), None);
    }

    #[test]
    fn room_noise_under_the_voice_is_cut_away() {
        // A voice at 0.3 over a room at 0.01: the room is under the bar.
        let take = [tone(1000, 0.01), tone(500, 0.3), tone(1000, 0.01)].concat();
        let r = spoken(&take, RATE).unwrap();
        assert_eq!((r.start, r.end), (800 * 16, 1700 * 16));
    }

    #[test]
    fn a_weak_take_is_lifted_to_the_same_peak_as_a_strong_one() {
        assert!((peak(&lift(&tone(200, 0.07))) - 0.9).abs() < 0.01);
        assert!((peak(&lift(&tone(200, 1.0))) - 0.9).abs() < 0.01);
    }

    #[test]
    fn the_lift_has_a_ceiling() {
        // 0.001 times thirty, not times nine hundred.
        assert!((peak(&lift(&tone(200, 0.001))) - 0.03).abs() < 0.001);
        assert_eq!(lift(&quiet(10)), quiet(10));
    }
}
