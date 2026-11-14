#!/bin/bash
# Builds the game's sound effects.
#   tools/build_sfx.sh <sonniss dir> <kenney dir>
# <sonniss dir>: the WAVs picked from the Sonniss GDC 2016/2017 game-audio bundles (royalty-free
#   for use inside a game, no attribution; they may not be handed out as sound files), plus one
#   CC0 grenade-launcher clip from freesound.org (163458 by LeMudCrab).
# <kenney dir>:  Kenney's CC0 packs unzipped side by side (sci-fi-sounds, impact-sounds,
#   interface-sounds), used for a few interface sounds and the glass smash.
# Needs ffmpeg. Output: public/assets/sfx/*.mp3
#
# Rules that keep it from sounding chopped: every cut starts on the transient with a 3 ms
# fade-in, keeps the natural tail, and fades out over the last part instead of stopping; every
# clip is then peak-normalised so the in-game mix decides loudness.
set -euo pipefail
S="${1:?sonniss dir}"; K="${2:?kenney dir}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/public/assets/sfx"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
SF="$K/sci-fi-sounds/Audio"; IM="$K/impact-sounds/Audio"; UI="$K/interface-sounds/Audio"
mkdir -p "$OUT"; rm -f "$OUT"/*.mp3
ff() { ffmpeg -nostdin -hide_banner -loglevel error -y "$@"; }
F="aformat=sample_rates=44100:channel_layouts=mono"

# clip START DUR FADE_FROM: one event with its tail, fading out from FADE_FROM to the end
sub() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.3f", a - b }'; }
clip() { local d; d=$(sub "$2" "$3"); echo "$F,atrim=start=$1:duration=$2,asetpts=PTS-STARTPTS,afade=t=in:d=0.003,afade=t=out:st=$3:d=$d"; }
# pitch RATE: tape-style speed/pitch change
pitch() { echo "asetrate=44100*$1,aresample=44100"; }
# render NAME PEAK_DB GRAPH INPUT...: run a filter graph ending in [o], normalise, encode
render() {
  local name="$1" peak="$2" graph="$3"; shift 3
  local args=(); for f in "$@"; do args+=(-i "$f"); done
  ff "${args[@]}" -filter_complex "$graph" -map "[o]" -ac 1 -ar 44100 "$TMP/$name.wav"
  local max; max=$(ffmpeg -nostdin -hide_banner -i "$TMP/$name.wav" -af volumedetect -f null - 2>&1 | sed -n 's/.*max_volume: \(.*\) dB/\1/p')
  ff -i "$TMP/$name.wav" -af "volume=$(sub "$peak" "$max")dB" -c:a libmp3lame -b:a 128k "$OUT/$name.mp3"
}
one() { render "$1" "$2" "[0:a]$4[o]" "$3"; }      # one NAME PEAK_DB INPUT CHAIN

# ---- gunshots ------------------------------------------------------------------------------
# rifle: a room-recorded HK416 shot for the tail, the close on-gun mic for the crack
render rattler -1 "[0:a]$(clip 3.805 0.85 0.28)[a];[1:a]$(clip 1.755 0.3 0.1),volume=0.5[b];[a][b]amix=inputs=2:normalize=0:duration=longest[o]" \
  "$S/audiobeast_small_room_h_k_416_5.56_assault_rifle_05m_ls5_001_single_shot_x1.wav" "$S/hk_416_5.56mm_on_gun_dpa4062_clean_seven_shots_x_1.wav"
# sidearm: revolver shot pitched up a little, with the last Glock shot for snap
render sidearm -1 "[0:a]$(clip 0 1.0 0.4),$(pitch 1.1)[a];[1:a]$(clip 1.345 0.4 0.12),volume=0.45[b];[a][b]amix=inputs=2:normalize=0:duration=longest[o]" \
  "$S/gun_revolver_pistol_shot_04.wav" "$S/glock_18_1m_left_off_axis_mkh416_clean_six_shots_x_1.wav"
# shotgun: the blast, then the pump racking
render scatter -1 "[0:a]$(clip 0 1.4 0.6)[a];[1:a]$(clip 0 1.2 0.8),adelay=330,volume=0.55[b];[a][b]amix=inputs=2:normalize=0:duration=longest[o]" \
  "$S/shotgun_fire_round_eject_01.wav" "$S/shotgun_quick_pump_01.wav"
# marksman rifle: the shot, then the action cycling
render longshot -1 "[0:a]$(clip 0 1.7 0.9)[a];[1:a]$(clip 0 0.6 0.4),adelay=620,volume=0.35[b];[a][b]amix=inputs=2:normalize=0:duration=longest[o]" \
  "$S/gun_rifle_sniper_shot_01.wav" "$S/gun_semi_auto_rifle_cock_02.wav"
# launcher: real grenade-launcher thump with a low body under it
render thumper -1 "[0:a]$F,afade=t=out:st=0.25:d=0.19[a];[1:a]$(clip 0 0.48 0.2),$(pitch 0.65),volume=0.7[b];[a][b]amix=inputs=2:normalize=0:duration=longest,aecho=0.8:0.5:70:0.2[o]" \
  "$S/163458_2263027-hq.ogg" "$S/punch_general_body_impact_03.wav"
one fizz -6 "$S/foley_soldier_gear_equipment_metal_cloth_heavy_movement_light_08.wav" "$(clip 0 0.6 0.3)"

# ---- explosions ----------------------------------------------------------------------------
render boom -1 "[0:a]$(clip 0 3.0 1.6)[a];[1:a]$F,volume=0.5[b];[a][b]amix=inputs=2:normalize=0:duration=longest[o]" \
  "$S/explosion_med_long_tail_01.wav" "$IM/impactGlass_heavy_001.ogg"
render splash -1 "[0:a]$(clip 0 1.3 0.7)[a];[1:a]$(clip 0 1.7 0.9),volume=0.8[b];[a][b]amix=inputs=2:normalize=0:duration=longest[o]" \
  "$S/explosion_large_no_tail_03.wav" "$S/splatter_splat_153.wav"

# ---- hits and deaths -------------------------------------------------------------------------
one hit -3 "$S/bullet_impact_body_thump_02.wav" "$(clip 0 0.46 0.2)"
render head -3 "[0:a]$(clip 0 0.46 0.2),$(pitch 1.2)[a];[1:a]$(clip 0 0.6 0.15),volume=0.3[b];[a][b]amix=inputs=2:normalize=0:duration=longest[o]" \
  "$S/bullet_impact_body_thump_02.wav" "$S/bullet_impact_metal_heavy_08.wav"
one kill -3 "$S/sfx-arcadia_itempickup16.wav" "$(clip 0 0.54 0.3)"
one hurt -3 "$S/punch_general_body_impact_03.wav" "$(clip 0 0.47 0.25)"
render die -2 "[0:a]$(clip 0 1.7 0.8)[a];[1:a]$(clip 0 0.5 0.3),volume=0.8[b];[a][b]amix=inputs=2:normalize=0:duration=longest[o]" \
  "$S/splatter_splat_153.wav" "$S/punch_grit_wet_impact_05.wav"
one impact -6 "$S/bullet_impact_concrete_brick_01.wav" "$(clip 0 0.34 0.15)"

# ---- handling --------------------------------------------------------------------------------
one reload -4 "$S/heckler___koch_g36c_5.56mm_foley_close_up_mkh60_mag_in___out.wav" "$(clip 3.72 1.05 0.85)"
one ready -4 "$S/gun_semi_auto_rifle_cock_02.wav" "$(clip 0 0.6 0.4)"
one empty -6 "$S/steyr_tmp_9mm_foley_distant_mkh418s_s_cocking___dry_fire.wav" "$(clip 1.95 0.25 0.1)"
one swap -5 "$S/mechanism_-_assaultrifle_pickup_004.wav" "$(clip 0 0.6 0.35)"
one bounce -5 "$S/shotgunshell_land_concrete_02.wav" "$(clip 0 0.85 0.4)"

# ---- movement --------------------------------------------------------------------------------
one step0 -6 "$S/fs_concrete_soldier_crouch_n02.wav" "$(clip 0 0.55 0.25)"
one step1 -6 "$S/fs_concrete_soldier_crouch_n05.wav" "$(clip 0 0.55 0.25)"
one step2 -6 "$S/fs_concrete_soldier_crouch_n02.wav" "$(clip 0 0.55 0.25),$(pitch 1.08)"
one step3 -6 "$S/fs_concrete_soldier_crouch_n05.wav" "$(clip 0 0.55 0.25),$(pitch 0.93)"
one jump -6 "$S/foley_object_grab_pickup_04.wav" "$(clip 0 0.5 0.25)"
one land -4 "$S/289_foley_footsteps_rocks_sneaker_jump_land_on_two_feet_close.wav" "$(clip 0.985 0.5 0.22)"

# ---- game events and interface -----------------------------------------------------------------
one pickup -4 "$S/collect_item_14.wav" "$(clip 0 1.45 0.8)"
one ui -6 "$S/user_interface_click_button_25.wav" "$(clip 0 0.4 0.15)"
one spawn -5 "$SF/forceField_000.ogg" "$F,$(pitch 1.4),afade=t=out:st=0.35:d=0.3"
one round -4 "$UI/confirmation_004.ogg" "$F"
one streak -4 "$UI/confirmation_002.ogg" "$F"
one chat -6 "$UI/pluck_001.ogg" "$F"

echo "$(ls "$OUT" | wc -l | tr -d ' ') clips, $(du -sk "$OUT" | cut -f1) KB"
