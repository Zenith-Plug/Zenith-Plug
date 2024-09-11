import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import pkg from 'discord.js';

const { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } = pkg;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());

const redeemedKeys = new Map();
const usedOrderIdsFilePath = path.join(process.cwd(), 'usedOrderIds.json');

// Initialize Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

client.login(process.env.DISCORD_BOT_TOKEN);

// Serve static files
app.use('/redeem', express.static(path.join(process.cwd(), 'redeem')));
app.use('/convert', express.static(path.join(process.cwd(), 'convert')));
app.use('/gbprobux', express.static(path.join(process.cwd(), 'gbprobux')));
app.use('/usdrobux', express.static(path.join(process.cwd(), 'usdrobux')));
app.use('/welcome', express.static(path.join(process.cwd(), 'welcome')));

app.get('/', (req, res) => {
    res.redirect('/welcome');
});

// Load used order IDs from JSON file
async function loadUsedOrderIds() {
    try {
        const data = await fs.readFile(usedOrderIdsFilePath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading used order IDs:', error);
        return [];
    }
}

// Save used order IDs to JSON file
async function saveUsedOrderIds(orderIds) {
    try {
        await fs.writeFile(usedOrderIdsFilePath, JSON.stringify(orderIds, null, 2), 'utf-8');
    } catch (error) {
        console.error('Error writing used order IDs:', error);
    }
}

// Load keys from JSON file
async function loadKeys() {
    try {
        const data = await fs.readFile('keys.json', 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading keys:', error);
        return {};
    }
}

// Redeem key endpoint
app.post('/redeem-key', async (req, res) => {
    try {
        const { key } = req.body;
        console.log('Redeem Key Request Body:', req.body);

        const keys = await loadKeys();

        if (!keys[key]) {
            return res.status(400).send({ success: false, message: 'Invalid key.' });
        }

        if (keys[key] !== "unused") {
            return res.status(400).send({ success: false, message: 'This key has already been used or is invalid.' });
        }

        keys[key] = 'used';
        await fs.writeFile('keys.json', JSON.stringify(keys, null, 2), 'utf-8');

        const robuxValueMatch = key.match(/^(\d+)-R\$-/);
        if (!robuxValueMatch) {
            return res.status(400).send({ success: false, message: 'Invalid key format.' });
        }

        const robuxValue = parseInt(robuxValueMatch[1]);
        redeemedKeys.set(req.ip, robuxValue);

        res.send({ success: true, message: 'Key redeemed successfully!' });
    } catch (error) {
        console.error("Error redeeming key:", error);
        res.status(500).send({ success: false, message: "An unexpected error occurred, please try again later." });
    }
});

// Validate Game Pass and User ID
app.post('/validate-gamepass', async (req, res) => {
    try {
        const { gamePassLink, userId, orderId } = req.body;
		
		const ip_address = (req.headers['x-forwarded-for'] || req.ip).split(',')[0].trim();

        console.log('Request received at /validate-gamepass');
        console.log('GamePassLink:', gamePassLink);
        console.log('Received userId:', userId);

        const robuxValue = redeemedKeys.get(req.ip);
        console.log('Retrieved Robux Value:', robuxValue);

        if (!userId || !/^\d{18,19}$/.test(userId)) {
            console.error('Invalid Discord User ID');
            return res.status(400).send({ success: false, message: 'Invalid Discord User ID. Please enter a valid user ID.' });
        }

        if (!robuxValue) {
            return res.status(400).send({ success: false, message: "No key found for this session. Please redeem a key first." });
        }

        if (!gamePassLink) {
            console.error("Game Pass Link not provided in the request body.");
            return res.status(400).send({ success: false, message: "Game Pass Link is required." });
        }

        const usedOrderIds = await loadUsedOrderIds();
        if (usedOrderIds.includes(orderId)) {
            return res.status(400).send({ success: false, message: 'This order ID has already been used.' });
        }

        try {
            const gamePassId = gamePassLink.trim();
            const apiUrl = `https://apis.roblox.com/game-passes/v1/game-passes/${gamePassId}/product-info`;

            const apiResponse = await fetch(apiUrl);
            console.log(`Roblox API response status: ${apiResponse.status}`);

            if (apiResponse.ok) {
                const data = await apiResponse.json();
                const gamePassPriceInRobux = data.PriceInRobux;

                if (typeof gamePassPriceInRobux !== 'number') {
                    console.error('PriceInRobux is not a number:', gamePassPriceInRobux);
                    return res.status(400).send({ success: false, message: "Failed to retrieve the correct price from the game pass." });
                }

                if (gamePassPriceInRobux !== robuxValue) {
                    return res.status(400).send({ success: false, message: `Your game pass must be set to ${robuxValue} Robux, not ${gamePassPriceInRobux} Robux.` });
                }

                usedOrderIds.push(orderId);
                await saveUsedOrderIds(usedOrderIds);

                res.status(200).send({ success: true, message: "Details submitted successfully!", gamePassData: { priceInRobux: gamePassPriceInRobux } });

                await send_order_notification(userId, robuxValue, orderId, gamePassId, ip_address);

            } else {
                return res.status(apiResponse.status).send({ success: false, message: `Error fetching game pass data. Status: ${apiResponse.status}` });
            }
        } catch (error) {
            console.error("Error fetching game pass data:", error);
            return res.status(500).send({ success: false, message: "An error occurred while validating the game pass." });
        }
    } catch (error) {
        console.error("Error in validate-gamepass:", error);
        res.status(500).send({ success: false, message: "An unexpected error occurred, please try again later." });
    }
});

async function send_order_notification(user_id, robux_value, order_id, game_pass_id, ip_address) {
    try {
        // Embed for the customer (no IP address)
        const customerEmbed = new EmbedBuilder()
            .setTitle("ORDER")
            .setColor(0x28a745)
            .addFields(
                { name: "**CUSTOMER:**", value: `<@${user_id}>` },
                { name: "**ORDER:**", value: `${robux_value} R$` },
                { name: "**ORDER-ID:**", value: `${order_id}` },
                { name: "**GAMEPASS:**", value: `[Buy here](https://www.roblox.com/game-pass/${game_pass_id}/)` },
                { name: "**STATUS:**", value: "Awaiting confirmation by <@981252386876174336>" }
            );

        const customer = await client.users.fetch(user_id);

        try {
            await customer.send({ embeds: [customerEmbed] });
            console.log(`Message sent to user: ${customer.tag}`);
        } catch (err) {
            console.error(`Error sending message to user ${user_id}: ${err.message}`);
            throw new Error("Cannot send messages to this user");
        }

        // Embed for the admin (with IP address)
        const adminEmbed = new EmbedBuilder()
            .setTitle("ORDER")
            .setColor(0x28a745)
            .addFields(
                { name: "**CUSTOMER:**", value: `<@${user_id}>` },
                { name: "**ORDER:**", value: `${robux_value} R$` },
                { name: "**ORDER-ID:**", value: `${order_id}` },
                { name: "**GAMEPASS:**", value: `[Buy here](https://www.roblox.com/game-pass/${game_pass_id}/)` },
                { name: "**IP ADDRESS:**", value: `${ip_address}` },  // Only shown to the admin
                { name: "**STATUS:**", value: "Awaiting confirmation by <@981252386876174336>" }
            );

        const admin = await client.users.fetch('981252386876174336');
        const confirmButton = new ButtonBuilder().setCustomId('confirm_order').setLabel('Complete').setStyle(ButtonStyle.Success);
        const holdButton = new ButtonBuilder().setCustomId('hold_order').setLabel('Hold').setStyle(ButtonStyle.Primary);
        const denyButton = new ButtonBuilder().setCustomId('deny_order').setLabel('Deny').setStyle(ButtonStyle.Danger);

        const actionRow = new ActionRowBuilder().addComponents(confirmButton, holdButton, denyButton);

        await admin.send({ embeds: [adminEmbed], components: [actionRow] });

    } catch (error) {
        console.error(`Error sending order notification: ${error.message}`);
        throw error;
    }
}

client.on('interactionCreate', async interaction => {
    try {
        if (!interaction.isButton()) return;

        if (interaction.customId === 'remind_customer') {
            const customerMention = interaction.message.content.match(/<@(\d+)>/);
            const userId = customerMention ? customerMention[1] : null;

            if (!userId) {
                console.error('Customer ID could not be extracted from message content');
                return interaction.reply({ content: 'Customer ID not found.', ephemeral: true });
            }

            const customer = await client.users.fetch(userId);
            const vouchReminder = `<@${userId}> This is an automatic reminder for you to **vouch for your purchase**.`;

            try {
                await customer.send({ content: vouchReminder });
                await interaction.reply({ content: 'Reminder sent successfully!', ephemeral: true });
            } catch (err) {
                console.error(`Error sending reminder to customer ${userId}: ${err.message}`);
                await interaction.reply({ content: 'Failed to send reminder to the customer.', ephemeral: true });
            }
            return;
        }

        const embed = interaction.message.embeds[0];

        if (!embed || !embed.fields) {
            console.error('No embed or embed fields found in the interaction message');
            return interaction.reply({ content: 'An error occurred. Embed data is missing.', ephemeral: true });
        }

        const orderField = embed.fields.find(f => f.name === '**ORDER:**');
        if (!orderField) {
            console.error('No **ORDER:** field found in the embed');
            return interaction.reply({ content: 'Order information is missing. Cannot proceed.', ephemeral: true });
        }

        const robuxValue = orderField.value.replace(' R$', '');

        if (interaction.customId === 'confirm_order') {
            const userId = embed.fields.find(f => f.name === '**CUSTOMER:**').value.replace(/<@|>/g, '');

            const confirmedEmbed = new EmbedBuilder()
                .setTitle('ORDER COMPLETED')
                .setColor(0x28a745)
                .addFields(
                    { name: '**CUSTOMER:**', value: `<@${userId}>` },
                    { name: '**ORDER:**', value: `${robuxValue} R$` },
                    { name: '**ORDER-ID:**', value: embed.fields.find(f => f.name === '**ORDER-ID:**').value },
                    { name: '**GAMEPASS:**', value: embed.fields.find(f => f.name === '**GAMEPASS:**').value },
                    { name: '**STATUS:**', value: `Confirmed by <@981252386876174336>` }
                );

            const customer = await client.users.fetch(userId);
            await customer.send({ embeds: [confirmedEmbed] });

            const priceInUSD = (robuxValue / 1000) * 4.1;
            const vouchEmbed = new EmbedBuilder()
                .setTitle('VOUCH REQUIREMENTS')
                .setColor(0x5865F2)
                .setDescription(`\`+rep <@981252386876174336> bought ${robuxValue} R$ | PayPal $${priceInUSD.toFixed(2)} USD\`\nWith a screenshot of your __pending__ robux\n<#1209285252195811342>`);

            await customer.send({ embeds: [vouchEmbed] });

            const remindButton = new ButtonBuilder()
                .setCustomId('remind_customer')
                .setLabel('Remind')
                .setStyle(ButtonStyle.Primary);

            const actionRow = new ActionRowBuilder().addComponents(remindButton);

            await interaction.reply({
                content: `Send <@${userId}> a vouch reminder?`,
                components: [actionRow],
                ephemeral: false
            });

        } else if (interaction.customId === 'deny_order') {
            const userId = embed.fields.find(f => f.name === '**CUSTOMER:**').value.replace(/<@|>/g, '');

            const denyEmbed = new EmbedBuilder()
                .setTitle('ROBUX ORDER DENIED')
                .setColor(0xFF0000)
                .addFields(
                    { name: '**CUSTOMER:**', value: `<@${userId}>` },
                    { name: '**ORDER:**', value: `${robuxValue} R$` },
                    { name: '**ORDER-ID:**', value: embed.fields.find(f => f.name === '**ORDER-ID:**').value },
                    { name: '**GAMEPASS:**', value: embed.fields.find(f => f.name === '**GAMEPASS:**').value },
                    { name: '**STATUS:**', value: 'Your order has been denied for the following reasons:\n- Incorrect gamepass.\n- Incorrect Order-ID.\n- Attempt to scam/fraud a key.' }
                );

            const customer = await client.users.fetch(userId);
            await customer.send({ embeds: [denyEmbed] });

            await interaction.reply({ content: 'Order has been denied!', ephemeral: true });

        } else if (interaction.customId === 'hold_order') {
            const userId = embed.fields.find(f => f.name === '**CUSTOMER:**').value.replace(/<@|>/g, '');

            const holdEmbed = new EmbedBuilder()
                .setTitle('ORDER ON HOLD')
                .setColor(0xFFA500)
                .addFields(
                    { name: '**CUSTOMER:**', value: `<@${userId}>` },
                    { name: '**ORDER:**', value: `${robuxValue} R$` },
                    { name: '**ORDER-ID:**', value: embed.fields.find(f => f.name === '**ORDER-ID:**').value },
                    { name: '**GAMEPASS:**', value: embed.fields.find(f => f.name === '**GAMEPASS:**').value },
                    { name: '**STATUS:**', value: 'Order is on hold. We apologize for the wait.' }
                );

            const customer = await client.users.fetch(userId);
            try {
                await customer.send({ embeds: [holdEmbed] });
                await interaction.reply({ content: 'Order has been put on hold!', ephemeral: true });
            } catch (err) {
                console.error(`Error sending HOLD message to customer ${userId}: ${err.message}`);
                await interaction.reply({ content: 'Order has been put on hold, but the message could not be sent to the customer.', ephemeral: true });
            }

        }
    } catch (error) {
        console.error('Error handling interaction:', error);
        await interaction.reply({ content: 'An unexpected error occurred. Please try again later.', ephemeral: true });
    }
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send({
        success: false,
        message: 'An unexpected error occurred, please try again later.'
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
