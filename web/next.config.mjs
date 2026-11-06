export default {
  // The public landing page is the guided demo; the raw dashboard lives at
  // /dashboard for local use.
  async redirects() {
    return [{ source: "/", destination: "/demo", permanent: false }];
  },
};
