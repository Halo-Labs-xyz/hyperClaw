import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
});

export default withSerwist({
  experimental: {
    serverComponentsExternalPackages: [
      "@lit-protocol/lit-client",
      "@lit-protocol/auth",
      "@lit-protocol/contracts",
      "@lit-protocol/networks",
      "@lit-protocol/access-control-conditions",
      "ethers",
      "bn.js",
      "viem",
      "@noble/curves",
      "@noble/hashes",
      "@privy-io/react-auth",
      "@privy-io/wagmi",
      "@tanstack/react-query",
      "wagmi",
    ],
  },
  images: {
    domains: [
      "imagedelivery.net",
      "testnet.monadvision.com",
      "monadvision.com",
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
