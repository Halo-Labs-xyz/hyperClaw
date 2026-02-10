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
  webpack: (config) => {
    // Silence MetaMask SDK warning about @react-native-async-storage/async-storage
    // This module is only needed in React Native and safely ignored in web builds
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "@react-native-async-storage/async-storage": false,
    };
    return config;
  },
});
