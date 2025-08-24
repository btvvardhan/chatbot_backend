import os
import json
import firebase_admin
from firebase_admin import credentials, firestore, firestore_async

# Initialize the Firebase app
try:
    # Use the environment variable for the service account key
    service_account_info = json.loads(os.environ.get('FIREBASE_CONFIG'))

    # Netlify/CI often escape newlines in the private key, so we need to fix it.
    if service_account_info.get('private_key') and '\\n' in service_account_info['private_key']:
        service_account_info['private_key'] = service_account_info['private_key'].replace('\\n', '\n')

    # Initialize the app with the service account credentials
    cred = credentials.Certificate(service_account_info)
    firebase_admin.initialize_app(cred)

except ValueError as e:
    print(f"Error initializing Firebase: {e}")
    raise Exception("FIREBASE_CONFIG environment variable is not a valid JSON string.")
except KeyError as e:
    print(f"Error initializing Firebase: Missing key {e}")
    raise Exception("FIREBASE_CONFIG environment variable is missing a required key.")

db = firestore.client()
db_async = firestore_async.client()


async def save_history(session_id, user_message, bot_reply):
    """
    Saves a single message pair (user + bot) to the conversation history subcollection.
    
    This method uses a subcollection to avoid the 1MB document size limit and the
    Firestore timestamp error when adding to an array. Each message is a separate document.
    """
    # Create a reference to the subcollection for messages in this session
    col_ref = db.collection('chat_history').document(session_id).collection('messages')
    
    # Create the new message entry with a server-side timestamp
    new_entry = {
        'user': user_message,
        'bot': bot_reply,
        'timestamp': firestore.firestore.SERVER_TIMESTAMP,
    }
    
    # Add the new message as a document in the subcollection
    await col_ref.add(new_entry)


async def get_history(session_id):
    """
    Retrieves the chat history for a given session ID, ordered by timestamp.
    
    Returns an array of message dictionaries.
    """
    # Create a reference to the messages subcollection
    col_ref = db.collection('chat_history').document(session_id).collection('messages')
    
    # Fetch all documents in the subcollection, ordered by timestamp
    docs = await col_ref.order_by('timestamp').stream()
    
    # Convert the documents to a list of message dictionaries
    history = []
    async for doc in docs:
        history.append(doc.to_dict())
        
    return history

