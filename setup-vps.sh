#!/bin/bash

# Setup script for Ubuntu 24.04 VPS
# Run this script as root or with sudo

set -e

echo "🚀 Setting up Meal Plan Worker on Ubuntu 24.04..."

# Update system
echo "📦 Updating system packages..."
apt update && apt upgrade -y

# Install Node.js 20 (LTS)
echo "📦 Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt-get install -y nodejs

# Verify Node.js installation
echo "✅ Node.js version: $(node --version)"
echo "✅ npm version: $(npm --version)"

# Install PM2 for process management
echo "📦 Installing PM2..."
npm install -g pm2

# Create worker user (optional but recommended for security)
echo "👤 Creating worker user..."
if ! id "mealworker" &>/dev/null; then
    useradd -m -s /bin/bash mealworker
    usermod -aG sudo mealworker
    echo "✅ Created user: mealworker"
else
    echo "ℹ️ User mealworker already exists"
fi

# Create application directory
echo "📁 Setting up application directory..."
WORKER_DIR="/opt/meal-plan-worker"
mkdir -p $WORKER_DIR
chown mealworker:mealworker $WORKER_DIR

# Create logs directory
mkdir -p $WORKER_DIR/logs
chown mealworker:mealworker $WORKER_DIR/logs

echo "✅ Basic VPS setup completed!"
echo ""
echo "Next steps:"
echo "1. Copy your worker files to $WORKER_DIR"
echo "2. Set up environment variables in $WORKER_DIR/.env"
echo "3. Run: cd $WORKER_DIR && npm install"
echo "4. Build the project: npm run build"
echo "5. Start with PM2: pm2 start ecosystem.config.js"
echo ""
echo "To switch to worker user: sudo su - mealworker"