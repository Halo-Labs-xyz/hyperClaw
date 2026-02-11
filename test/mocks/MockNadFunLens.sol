// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockNadFunLens {
    struct CurveState {
        uint256 virtualMon;
        uint256 virtualToken;
        uint256 realMon;
        uint256 realToken;
        uint256 totalSupply;
        bool isGraduated;
    }

    mapping(address => CurveState) internal states;

    function setCurveState(
        address token,
        uint256 virtualMon,
        uint256 virtualToken,
        uint256 realMon,
        uint256 realToken,
        uint256 totalSupply,
        bool isGraduated
    ) external {
        states[token] = CurveState({
            virtualMon: virtualMon,
            virtualToken: virtualToken,
            realMon: realMon,
            realToken: realToken,
            totalSupply: totalSupply,
            isGraduated: isGraduated
        });
    }

    function getCurveState(address token)
        external
        view
        returns (
            uint256 virtualMon,
            uint256 virtualToken,
            uint256 realMon,
            uint256 realToken,
            uint256 totalSupply,
            bool isGraduated
        )
    {
        CurveState memory s = states[token];
        if (s.virtualToken == 0) {
            // High-cap default so tests are not capped at tier 0.
            return (50_000e18, 1e18, 0, 0, 50_000e18, false);
        }
        return (s.virtualMon, s.virtualToken, s.realMon, s.realToken, s.totalSupply, s.isGraduated);
    }
}
