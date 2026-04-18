import asyncio
from pyrogram import Client
from Backend.config import Telegram
from Backend import db
from datetime import datetime
from Backend.logger import LOGGER

async def subscription_checker_loop(bot: Client):
    while True:
        try:
            if not Telegram.SUBSCRIPTION:
                await asyncio.sleep(3600)
                continue

            LOGGER.info(f"Running subscription checker for group: {Telegram.SUBSCRIPTION_GROUP_ID}")
            
            # Verify group access
            try:
                await bot.get_chat(Telegram.SUBSCRIPTION_GROUP_ID)
            except Exception as e:
                LOGGER.error(f"Subscription Group Verification Failed ({Telegram.SUBSCRIPTION_GROUP_ID}): {e}")
                # Don't try to kick users if the group itself is invalid/inaccessible
                await asyncio.sleep(3600)
                continue

            # 1. Fetch expired users & kick them
            expired_users = await db.get_expired_users()
            admin_ids = Telegram.APPROVER_IDS + [Telegram.OWNER_ID]
            
            for user in expired_users:
                user_id = user["_id"]
                
                # Skip admins and approvers
                if user_id in admin_ids:
                    # Optional: mark them as not expired if they somehow got that status
                    # await db.update_user_subscription(user_id, status="active") 
                    continue
                
                try:
                    # Ban then unban to kick the user without permanently banning them
                    await bot.ban_chat_member(Telegram.SUBSCRIPTION_GROUP_ID, user_id)
                    await bot.unban_chat_member(Telegram.SUBSCRIPTION_GROUP_ID, user_id)
                    
                    await db.mark_user_expired(user_id)
                    
                    # Notify user
                    try:
                        await bot.send_message(
                            user_id,
                            "❌ <b>Subscription Expired</b>\n\n"
                            "Your subscription has expired, and you have been removed from the private group.\n"
                            f"Please go to {Telegram.SUBSCRIPTION_URL} and send /start to renew your subscription and regain access."
                        )
                    except Exception:
                        pass # User might have blocked the bot
                    
                    LOGGER.info(f"Kicked expired user {user_id}")
                except Exception as e:
                    LOGGER.error(f"Failed to kick expired user {user_id} from {Telegram.SUBSCRIPTION_GROUP_ID}: {e}")

            # 2. Remind users expiring in 24 hours
            expiring_users = await db.get_expiring_users(hours=24)
            for user in expiring_users:
                user_id = user["_id"]
                expiry = user["subscription_expiry"]
                try:
                    await bot.send_message(
                        user_id,
                        f"⚠️ <b>Subscription Expiring Soon</b>\n\n"
                        f"Your subscription will expire on <b>{expiry.strftime('%Y-%m-%d %H:%M UTC')}</b>.\n"
                        f"Please go to {Telegram.SUBSCRIPTION_URL} and send /start to renew your plan before you lose access to the group!"
                    )
                    await db.mark_reminder_sent(user_id)
                    LOGGER.info(f"Sent expiry reminder to user {user_id}")
                except Exception as e:
                    LOGGER.error(f"Failed to send reminder to user {user_id}: {e}")

            # Check every hour
            await asyncio.sleep(3600)

        except Exception as e:
            LOGGER.error(f"Error in subscription checker loop: {e}")
            await asyncio.sleep(300) # Wait 5 minutes before retrying on error
