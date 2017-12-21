/*
The snapshot feature is responsible for saving the player state before an ad, then
restoring the player state after an ad.
*/

import window from 'global/window';

import videojs from 'video.js';

/*
 * Returns an object that captures the portions of player state relevant to
 * video playback. The result of this function can be passed to
 * restorePlayerSnapshot with a player to return the player to the state it
 * was in when this function was invoked.
 * @param {Object} player The videojs player object
 */
export function getPlayerSnapshot(player) {
  let currentTime;

  if (videojs.browser.IS_IOS && player.ads.isLive(player)) {
    // Record how far behind live we are
    if (player.seekable().length > 0) {
      currentTime = player.currentTime() - player.seekable().end(0);
    } else {
      currentTime = player.currentTime();
    }
  } else {
    currentTime = player.currentTime();
  }

  const tech = player.$('.vjs-tech');
  const remoteTracks = player.remoteTextTracks ? player.remoteTextTracks() : [];
  const tracks = player.textTracks ? player.textTracks() : [];
  const suppressedRemoteTracks = [];
  const suppressedTracks = [];
  const snapshotObject = {
    ended: player.ended(),
    currentSrc: player.currentSrc(),
    src: player.tech_.src(),
    currentTime,
    type: player.currentType()
  };

  if (tech) {
    snapshotObject.nativePoster = tech.poster;
    snapshotObject.style = tech.getAttribute('style');
  }

  for (let i = 0; i < remoteTracks.length; i++) {
    const track = remoteTracks[i];

    suppressedRemoteTracks.push({
      track,
      mode: track.mode
    });
    track.mode = 'disabled';
  }
  snapshotObject.suppressedRemoteTracks = suppressedRemoteTracks;

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];

    suppressedTracks.push({
      track,
      mode: track.mode
    });
    track.mode = 'disabled';
  }
  snapshotObject.suppressedTracks = suppressedTracks;

  return snapshotObject;
}

/*
 * Attempts to modify the specified player so that its state is equivalent to
 * the state of the snapshot.
 * @param {Object} player - the videojs player object
 * @param {Object} snapshotObject - the player state to apply
 */
export function restorePlayerSnapshot(player, snapshotObject) {
  if (player.ads.disableNextSnapshotRestore === true) {
    player.ads.disableNextSnapshotRestore = false;
    return;
  }

  // The playback tech
  let tech = player.$('.vjs-tech');

  // the number of[ remaining attempts to restore the snapshot
  let attempts = 20;

  const suppressedRemoteTracks = snapshotObject.suppressedRemoteTracks;
  const suppressedTracks = snapshotObject.suppressedTracks;

  let trackSnapshot;
  const restoreTracks = function() {
    for (let i = 0; i < suppressedRemoteTracks.length; i++) {
      trackSnapshot = suppressedRemoteTracks[i];
      trackSnapshot.track.mode = trackSnapshot.mode;
    }

    for (let i = 0; i < suppressedTracks.length; i++) {
      trackSnapshot = suppressedTracks[i];
      trackSnapshot.track.mode = trackSnapshot.mode;
    }
  };

  // Finish restoring the playback state.
  // This only happens if the content video element was reused for ad playback.
  const resume = function() {
    let currentTime;

    // Live video on iOS has special logic to try to seek to the right place after
    // an ad.
    if (videojs.browser.IS_IOS && player.ads.isLive(player)) {
      if (snapshotObject.currentTime < 0) {
        // Playback was behind real time, so seek backwards to match
        if (player.seekable().length > 0) {
          currentTime = player.seekable().end(0) + snapshotObject.currentTime;
        } else {
          currentTime = player.currentTime();
        }
        player.currentTime(currentTime);
        player.play();
      }

    // Restore the video position after an ad.
    // We check snapshotObject.ended because the content starts at the beginning again
    // after being restored.
    } else if (snapshotObject.ended) {
      // For postrolls, seek to the player's current duration.
      // It could be different from the snapshot's currentTime due to
      // inaccuracy in HLS.
      player.currentTime(player.duration());
    } else {
      // Prerolls and midrolls, just seek to the player time before the ad.
      player.currentTime(snapshotObject.currentTime);
      player.play();
    }

    // if we added autoplay to force content loading on iOS, remove it now
    // that it has served its purpose
    if (player.ads.shouldRemoveAutoplay_) {
      player.autoplay(false);
      player.ads.shouldRemoveAutoplay_ = false;
    }
  };

  // Determine if the video element has loaded enough of the snapshot source
  // to be ready to apply the rest of the state.
  // This only happens if the content video element was reused for ad playback.
  const tryToResume = function() {

    // tryToResume can either have been called through the `contentcanplay`
    // event or fired through setTimeout.
    // When tryToResume is called, we should make sure to clear out the other
    // way it could've been called by removing the listener and clearing out
    // the timeout.
    player.off('contentcanplay', tryToResume);
    if (player.ads.tryToResumeTimeout_) {
      player.clearTimeout(player.ads.tryToResumeTimeout_);
      player.ads.tryToResumeTimeout_ = null;
    }

    // Tech may have changed depending on the differences in sources of the
    // original video and that of the ad
    tech = player.el().querySelector('.vjs-tech');

    if (tech.readyState > 1) {
      // some browsers and media aren't "seekable".
      // readyState greater than 1 allows for seeking without exceptions
      return resume();
    }

    if (tech.seekable === undefined) {
      // if the tech doesn't expose the seekable time ranges, try to
      // resume playback immediately
      return resume();
    }

    if (tech.seekable.length > 0) {
      // if some period of the video is seekable, resume playback
      return resume();
    }

    // delay a bit and then check again unless we're out of attempts
    if (attempts--) {
      window.setTimeout(tryToResume, 50);
    } else {
      try {
        resume();
      } catch (e) {
        videojs.log.warn('Failed to resume the content after an advertisement', e);
      }
    }
  };

  if (snapshotObject.nativePoster) {
    tech.poster = snapshotObject.nativePoster;
  }

  if ('style' in snapshotObject) {
    // overwrite all css style properties to restore state precisely
    tech.setAttribute('style', snapshotObject.style || '');
  }

  // Determine whether the player needs to be restored to its state
  // before ad playback began. With a custom ad display or burned-in
  // ads, the content player state hasn't been modified and so no
  // restoration is required

  if (player.ads.videoElementRecycled()) {
    // on ios7, fiddling with textTracks too early will cause safari to crash
    player.one('contentloadedmetadata', restoreTracks);

    // adding autoplay guarantees that Safari will load the content so we can
    // seek back to the correct time after ads
    if (videojs.browser.IS_IOS && !player.autoplay()) {
      player.autoplay(true);

      // if we get here, the player was not originally configured to autoplay,
      // so we should remove it after it has served its purpose
      player.ads.shouldRemoveAutoplay_ = true;
    }

    // if the src changed for ad playback, reset it
    player.src({ src: snapshotObject.currentSrc, type: snapshotObject.type });

    // and then resume from the snapshots time once the original src has loaded
    // in some browsers (firefox) `canplay` may not fire correctly.
    // Reace the `canplay` event with a timeout.
    player.one('contentcanplay', tryToResume);
    player.ads.tryToResumeTimeout_ = player.setTimeout(tryToResume, 2000);
  } else if (!player.ended() || !snapshotObject.ended) {
    // if we didn't change the src, just restore the tracks
    restoreTracks();
    // the src didn't change and this wasn't a postroll
    // just resume playback at the current time.
    player.play();
  }
}
