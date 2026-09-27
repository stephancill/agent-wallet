// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {LowLevelCall} from "@openzeppelin/contracts/utils/LowLevelCall.sol";

/// @notice An EIP-7702 delegate whose CREATE2 address commits to its parent.
/// @dev Deploy the same initcode, including the constructor argument, on every supported chain.
contract AgentAccount is IERC1271, ERC721Holder, ERC1155Holder {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    address public immutable parent;

    error InvalidParent();
    error Unauthorized();
    error EmptyBatch();

    constructor(address parentAddress) {
        if (parentAddress == address(0)) revert InvalidParent();
        parent = parentAddress;
    }

    /// @notice An agent EOA may call itself; its parent may rescue assets directly.
    function executeBatch(Call[] calldata calls) external {
        if (msg.sender != address(this) && msg.sender != parent) revert Unauthorized();
        if (calls.length == 0) revert EmptyBatch();
        for (uint256 i = 0; i < calls.length; ++i) {
            if (!LowLevelCall.callNoReturn(calls[i].to, calls[i].value, calls[i].data)) {
                LowLevelCall.bubbleRevert();
            }
        }
    }

    /// @notice Integrations validate signatures made by the underlying agent EOA key.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == address(this)
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155Holder) returns (bool) {
        return interfaceId == type(IERC721Receiver).interfaceId || interfaceId == type(IERC1271).interfaceId
            || super.supportsInterface(interfaceId);
    }

    receive() external payable {}

    fallback() external payable {}
}
