---
title: Shopify
description: Connect a Shopify store through an app you create in your own Shopify organization.
sidebar:
  order: 6
---

lynox reaches a Shopify store through the Shopify Admin API. The sign-in is built in: you don't describe endpoints or the login flow. You create an app at Shopify and enter its credentials in lynox.

## Setup

The app is yours, not lynox's. You create it in your own Shopify organization. lynox stores the credentials you enter and uses them to sign in to your store.

### 1. Ask lynox to set up your store

In the chat, ask lynox to connect your Shopify store and give it the store's address (`your-store.myshopify.com`). lynox creates a connection profile for the store.

### 2. Create the app at Shopify

In your Shopify organization, create an app for the store. It needs a redirect URL, and lynox shows you which one:

1. In lynox, open **Settings → APIs** and find the Shopify profile.
2. The box **App credentials for Shopify** shows the address to enter as the redirect URL.
3. Enter that address as the redirect URL in your app at Shopify.

### 3. Enter the Client ID and Client Secret

Shopify shows the app's **Client ID** and **Client Secret**. Enter both in the same box in lynox and save. Only the owner of the lynox instance can do this.

:::caution[Only in this form, never in the chat]
Enter the Client Secret in this form only, never in the chat, even if a chat asks for it.
:::

After saving, the box shows that a Client Secret is stored, but not its value. To change it, use **Replace Client Secret**. If you enter a different Client ID, lynox asks for the Client Secret too, because a new ID means a different app.

lynox uses one Shopify app per instance. Entering a different app replaces it for the stores connected through the previous one. lynox asks you to confirm first, and those stores then need to connect again.

### 4. Connect

Ask lynox to connect the store. It gives you a link to Shopify, where you approve the access for your store. After that, lynox can read what you approved there. That is at most your store's products, orders, customers, inventory and fulfillments.
