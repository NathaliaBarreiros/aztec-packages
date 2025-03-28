#!/bin/bash

# URL of the aztec-sequencer.sh script
DEFAULT_URL="https://raw.githubusercontent.com/AztecProtocol/aztec-packages/refs/heads/master/spartan/releases/testnet/aztec-sequencer.sh"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Download the script
echo "Downloading aztec-sequencer.sh..."
if curl -L -o aztec-sequencer.sh "${1:-$DEFAULT_URL}"; then
    chmod +x aztec-sequencer.sh
    echo -e "${GREEN}✓ aztec-sequencer.sh has been downloaded and made executable${NC}"
    echo "You can now run it with: ./aztec-sequencer.sh"
else
    echo -e "${RED}✗ Failed to download aztec-sequencer.sh${NC}"
    exit 1
fi

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "jq is not installed. Installing jq..."
    if command -v apt-get &> /dev/null; then
        sudo apt-get update
        sudo apt-get install -y jq
    elif command -v yum &> /dev/null; then
        sudo yum install -y jq
    elif command -v brew &> /dev/null; then
        brew install jq
    else
        echo -e "${RED}✗ Could not install jq. Please install it manually.${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ jq has been installed${NC}"
fi
