// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AgentAccount} from "../src/AgentAccount.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

interface Vm {
    function addr(uint256 key) external returns (address);
    function sign(uint256 key, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function etch(address target, bytes calldata code) external;
    function deal(address target, uint256 balance) external;
    function prank(address caller) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
    function chainId(uint256 newChainId) external;
}

contract TestToken is ERC20 {
    constructor() ERC20("Test", "TEST") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract TestNFT is ERC721 {
    constructor() ERC721("Test NFT", "NFT") {}

    function mint(address recipient, uint256 id) external {
        _safeMint(recipient, id);
    }
}

contract Test1155 is ERC1155 {
    constructor() ERC1155("") {}

    function mint(address recipient, uint256 id, uint256 amount) external {
        _mint(recipient, id, amount, "");
    }
}

contract Counter {
    uint256 public count;

    function increment() external payable {
        count++;
    }

    function fail() external pure {
        revert("target failed");
    }
}

contract SmartParent {
    function rescue(AgentAccount account, AgentAccount.Call[] calldata calls) external {
        account.executeBatch(calls);
    }
}

contract AgentAccountTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant KEY = 0xA11CE;
    uint256 private constant OTHER_KEY = 0xB0B;

    AgentAccount private implementation;
    AgentAccount private agent;
    address private agentAddress;
    address private parentAddress;
    Counter private counter;

    function setUp() public {
        agentAddress = vm.addr(KEY);
        parentAddress = vm.addr(OTHER_KEY);
        implementation = new AgentAccount(parentAddress);
        vm.etch(agentAddress, abi.encodePacked(hex"ef0100", address(implementation)));
        agent = AgentAccount(payable(agentAddress));
        counter = new Counter();
        vm.deal(agentAddress, 10 ether);
    }

    function testConstructorCommitsParentToCREATE2AddressAcrossChains() public {
        bytes memory initcode = abi.encodePacked(type(AgentAccount).creationCode, abi.encode(parentAddress));
        bytes memory otherInitcode = abi.encodePacked(type(AgentAccount).creationCode, abi.encode(address(0xBAD)));
        bytes32 salt = bytes32(0);
        address expected = _create2(address(this), salt, keccak256(initcode));
        address otherExpected = _create2(address(this), salt, keccak256(otherInitcode));
        assert(expected != otherExpected);
        vm.chainId(8453);
        assert(_create2(address(this), salt, keccak256(initcode)) == expected);
        AgentAccount deployed = new AgentAccount{salt: salt}(parentAddress);
        assert(address(deployed) == expected);
        assert(deployed.parent() == parentAddress);
        assert(agent.parent() == parentAddress);
    }

    function testZeroParentCannotBeDeployed() public {
        vm.expectRevert(AgentAccount.InvalidParent.selector);
        new AgentAccount(address(0));
    }

    function testSelfAndParentExecuteButOthersCannot() public {
        AgentAccount.Call[] memory calls = _incrementCall();
        vm.expectRevert(AgentAccount.Unauthorized.selector);
        agent.executeBatch(calls);

        vm.prank(agentAddress);
        agent.executeBatch(calls);
        vm.prank(parentAddress);
        agent.executeBatch(calls);
        assert(counter.count() == 2);
    }

    function testParentRescuesTokensAndEthWithAtomicBatch() public {
        TestToken token = new TestToken();
        token.mint(agentAddress, 100);
        AgentAccount.Call[] memory calls = new AgentAccount.Call[](2);
        calls[0] = AgentAccount.Call(address(token), 0, abi.encodeCall(token.transfer, (parentAddress, 100)));
        calls[1] = AgentAccount.Call(parentAddress, 1 ether, "");
        uint256 beforeBalance = parentAddress.balance;
        vm.prank(parentAddress);
        agent.executeBatch(calls);
        assert(token.balanceOf(parentAddress) == 100);
        assert(parentAddress.balance == beforeBalance + 1 ether);
    }

    function testRevertedBatchRollsBackAllCalls() public {
        AgentAccount.Call[] memory calls = new AgentAccount.Call[](2);
        calls[0] = _incrementCall()[0];
        calls[1] = AgentAccount.Call(address(counter), 0, abi.encodeCall(Counter.fail, ()));
        vm.prank(parentAddress);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "target failed"));
        agent.executeBatch(calls);
        assert(counter.count() == 0);
    }

    function testEmptyBatchReverts() public {
        vm.prank(parentAddress);
        vm.expectRevert(AgentAccount.EmptyBatch.selector);
        agent.executeBatch(new AgentAccount.Call[](0));
    }

    function testSmartWalletParentCanRescue() public {
        SmartParent smartParent = new SmartParent();
        AgentAccount smartImplementation = new AgentAccount(address(smartParent));
        vm.etch(agentAddress, abi.encodePacked(hex"ef0100", address(smartImplementation)));
        smartParent.rescue(agent, _incrementCall());
        assert(counter.count() == 1);
        assert(agent.parent() == address(smartParent));
    }

    function testSafeNFTReceptionRescueAndFallback() public {
        TestNFT nft = new TestNFT();
        Test1155 multi = new Test1155();
        nft.mint(agentAddress, 7);
        multi.mint(agentAddress, 9, 3);
        assert(agent.supportsInterface(type(IERC721Receiver).interfaceId));
        assert(agent.supportsInterface(type(IERC1155Receiver).interfaceId));
        assert(agent.supportsInterface(type(IERC1271).interfaceId));
        (bool accepted,) = agentAddress.call(hex"abcdef01");
        assert(accepted);

        AgentAccount.Call[] memory calls = new AgentAccount.Call[](2);
        calls[0] = AgentAccount.Call(
            address(nft),
            0,
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", agentAddress, parentAddress, 7)
        );
        calls[1] = AgentAccount.Call(
            address(multi), 0, abi.encodeCall(multi.safeTransferFrom, (agentAddress, parentAddress, 9, 3, ""))
        );
        vm.prank(parentAddress);
        agent.executeBatch(calls);
        assert(nft.ownerOf(7) == parentAddress);
        assert(multi.balanceOf(parentAddress, 9) == 3);
    }

    function testERC1271AcceptsOnlyUnderlyingAgentEOAKey() public {
        bytes32 digest = keccak256("integration hash");
        assert(agent.isValidSignature(digest, _sign(KEY, digest)) == 0x1626ba7e);
        assert(agent.isValidSignature(digest, _sign(OTHER_KEY, digest)) == 0xffffffff);
        assert(agent.isValidSignature(digest, hex"1234") == 0xffffffff);
    }

    function _create2(address deployer, bytes32 salt, bytes32 initcodeHash) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", deployer, salt, initcodeHash)))));
    }

    function _incrementCall() private view returns (AgentAccount.Call[] memory calls) {
        calls = new AgentAccount.Call[](1);
        calls[0] = AgentAccount.Call(address(counter), 0, abi.encodeCall(Counter.increment, ()));
    }

    function _sign(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
