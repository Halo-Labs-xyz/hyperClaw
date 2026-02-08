import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
});

export default withSerwist({
  images: {
    domains: [
      "imagedelivery.net",
      "testnet.monadexplorer.com",
      "explorer.monad.xyz",
      "api.nadapp.net",
    ],
  },
});
