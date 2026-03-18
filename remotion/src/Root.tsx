import React from 'react';
import {Composition} from 'remotion';
import {
  Run402BuilderSpotlight,
  RUN402_DURATION_IN_FRAMES,
  RUN402_FPS,
  RUN402_HEIGHT,
  RUN402_WIDTH,
} from './Run402BuilderSpotlight';
import {
  TestVideo,
  TEST_VIDEO_DURATION,
  TEST_VIDEO_FPS,
  TEST_VIDEO_WIDTH,
  TEST_VIDEO_HEIGHT,
} from './TestVideo';
import {
  ClaudeCodeDemo,
  CC_DURATION,
  CC_FPS,
  CC_WIDTH,
  CC_HEIGHT,
} from './ClaudeCodeDemo';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Run402BuilderSpotlight"
        component={Run402BuilderSpotlight}
        durationInFrames={RUN402_DURATION_IN_FRAMES}
        fps={RUN402_FPS}
        width={RUN402_WIDTH}
        height={RUN402_HEIGHT}
      />
      <Composition
        id="TestVideo"
        component={TestVideo}
        durationInFrames={TEST_VIDEO_DURATION}
        fps={TEST_VIDEO_FPS}
        width={TEST_VIDEO_WIDTH}
        height={TEST_VIDEO_HEIGHT}
      />
      <Composition
        id="ClaudeCodeDemo"
        component={ClaudeCodeDemo}
        durationInFrames={CC_DURATION}
        fps={CC_FPS}
        width={CC_WIDTH}
        height={CC_HEIGHT}
      />
    </>
  );
};
