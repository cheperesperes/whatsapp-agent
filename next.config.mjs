/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // The video finalizer shells out to the ffmpeg-static binary and reads the
    // bundled brand font by path — neither is an `import`, so Next's tracer
    // doesn't include them automatically. Force them into the serverless bundle.
    outputFileTracingIncludes: {
      '/api/cron/finalize-videos': [
        './assets/fonts/**',
        './node_modules/ffmpeg-static/**',
      ],
    },
  },
};

export default nextConfig;
