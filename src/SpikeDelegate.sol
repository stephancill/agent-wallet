// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

/// @notice A deliberately minimal protocol fixture. Not a production account implementation.
contract SpikeDelegate {
    // The account's storage lives at the EOA, not at this implementation address.
    bytes32 private constant PARENT_SLOT = keccak256("agent-wallet.spike.parent.v1");

    function initDigest(address parentAddress) public view returns (bytes32) {
        return keccak256(abi.encode("agent-wallet.spike.init.v1", address(this), parentAddress, _implementation()));
    }

    function initialize(address parentAddress, bytes calldata signature) external {
        require(parentAddress != address(0) && _parent() == address(0), "already initialized");
        require(signature.length == 65, "bad signature length");
        bytes32 digest = initDigest(parentAddress);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(v == 27 || v == 28, "bad recovery id");
        require(ecrecover(digest, v, r, s) == address(this), "not agent proof");
        bytes32 slot = PARENT_SLOT;
        assembly {
            sstore(slot, parentAddress)
        }
    }

    function parent() external view returns (address) {
        return _parent();
    }

    function rescue(address payable recipient, uint256 amount) external {
        require(_parent() != address(0) && msg.sender == _parent(), "not parent");
        (bool success,) = recipient.call{value: amount}("");
        require(success, "rescue failed");
    }

    function _parent() private view returns (address result) {
        bytes32 slot = PARENT_SLOT;
        assembly {
            result := sload(slot)
        }
    }

    function _implementation() private view returns (address result) {
        // In a 7702 call, EXTCODECOPY(address(this)) returns the 23-byte pointer.
        assembly {
            let pointer := mload(0x40)
            extcodecopy(address(), pointer, 0, 23)
            result := shr(96, mload(add(pointer, 3)))
        }
    }
}
