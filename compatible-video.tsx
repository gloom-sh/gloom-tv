import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import type { MediaSurfaceHandle } from "gloomberb/ui";
import type { PlaybackState } from "./playback";

interface CompatibleVideoProps {
  src: string;
  title: string;
  poster?: string;
  muted: boolean;
  mediaHandleRef: Ref<MediaSurfaceHandle>;
  onPlaybackStateChange: (state: PlaybackState) => void;
  onMutedChange: (muted: boolean) => void;
  onError: () => void;
}

export function CompatibleVideo({ src, title, poster, muted, mediaHandleRef, onPlaybackStateChange, onMutedChange, onError }: CompatibleVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useImperativeHandle(mediaHandleRef, () => ({
    async play() { await videoRef.current?.play(); },
    pause() { videoRef.current?.pause(); },
    async toggle() {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) await video.play();
      else video.pause();
    },
    toggleMuted() {
      const video = videoRef.current;
      if (!video) return muted;
      video.muted = !video.muted;
      return video.muted;
    },
  }), [muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.src = src;
    return () => {
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);

  return <video
    ref={videoRef}
    title={title}
    aria-label={title}
    poster={poster}
    autoPlay
    muted={muted}
    controls
    playsInline
    style={{ flex: "1 1 0", minHeight: 0, width: "100%", background: "#050505" }}
    onLoadStart={() => onPlaybackStateChange("loading")}
    onWaiting={() => onPlaybackStateChange("loading")}
    onPlaying={() => onPlaybackStateChange("playing")}
    onPause={() => onPlaybackStateChange("paused")}
    onVolumeChange={(event) => onMutedChange(event.currentTarget.muted)}
    onError={() => onError()}
    onEnded={() => onError()}
  />;
}
