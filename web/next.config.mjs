export default {
  // `/` is the live dashboard; the guided explainer lives at `/explain`.
  async redirects() {
    return [{ source: "/demo", destination: "/", permanent: false }];
  },
};
