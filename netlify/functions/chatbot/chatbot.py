import os
import json
import requests
import asyncio
from .firestore_helper import save_history, get_history

# This is the main handler for the serverless function.
# It's called by Netlify when a request comes in.
def handler(event, context):
    # Only allow POST requests.
    if event['httpMethod'] != 'POST':
        return {
            'statusCode': 405,
            'body': 'Method Not Allowed'
        }

    # Get the Gemini API key from environment variables.
    gemini_api_key = os.environ.get('GEMINI_API_KEY')
    if not gemini_api_key:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'API key is not configured.'})
        }

    loop = None
    try:
        # Parse the JSON payload from the request body.
        body = json.loads(event['body'])
        user_message = body.get('message')
        session_id = body.get('sessionId')

        if not user_message or not session_id:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Message or sessionId is missing.'})
            }

        # Run the async operations.
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        # Get the chat history.
        history = loop.run_until_complete(get_history(session_id))
        
        # Create a conversational prompt with history.
        chat_history = "Previous conversation:\n"
        if history:
            for entry in history:
                chat_history += f"User: {entry.get('user')}\nBot: {entry.get('bot')}\n"
        else:
            chat_history += "No previous history.\n"
        chat_history += f"User: {user_message}"

        # Prepare the payload for the Gemini API.
        payload = {
            'contents': [{
                'parts': [{'text': chat_history}]
            }]
        }
        
        api_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key={gemini_api_key}"
        
        # Make the API call.
        response = requests.post(api_url, json=payload)
        
        if not response.ok:
            print(f"Gemini API Error: {response.status_code}, {response.text}")
            raise Exception(f"Gemini API returned an error: {response.status_code}")

        result = response.json()
        bot_reply = result.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', 'No reply from the bot.')

        # Save the new message pair to the database.
        loop.run_until_complete(save_history(session_id, user_message, bot_reply))

        return {
            'statusCode': 200,
            'body': json.dumps({'reply': bot_reply})
        }

    except Exception as e:
        print(f"Function Error: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': 'Failed to process the request.'})
        }
    finally:
        if loop:
            loop.close()
