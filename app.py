import json
import os
import requests
from flask import Flask, render_template, request, jsonify, Response, stream_with_context
import openai
import base64
import time
import asyncio
import concurrent.futures
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Initialize Flask app
app = Flask(__name__)

# API endpoints
BART_API = os.getenv("BART_API")

# OpenAI API Key
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

# Configure OpenAI
openai.api_key = OPENAI_API_KEY

# Thread pool for parallel processing
thread_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)

def get_bart_response(query):
    try:
        start_time = time.time()
        print(f"\n[BART Query] Sending request: {query}")
        
        # Prepare the payload for BART API using the correct format
        payload = {
            "query": query.get("input"),
            "session_id": query.get("session_id", "default")
        }
        
        # Make request to BART API
        response = requests.post(
            BART_API,
            json=payload,
            headers={'Content-Type': 'application/json'},
            timeout=5  # Add timeout to prevent hanging
        )
        
        if response.status_code != 200:
            print(f"[BART Error] Status code: {response.status_code}")
            raise Exception(f"BART API returned status code {response.status_code}")
        
        # Parse the response
        response_data = response.json()
        print(f"[BART Response] Raw response: {json.dumps(response_data, indent=2)}")
        
        # Extract text from the response - handle multiple possible formats
        if 'body' in response_data:
            try:
                body_data = json.loads(response_data['body'])
                
                # Format 1: "answer" is a direct string
                if 'answer' in body_data and isinstance(body_data['answer'], str):
                    bart_response = body_data['answer']
                    print(f"[BART Answer] {bart_response}")
                    print(f"[BART Timing] Response received in {time.time() - start_time:.2f} seconds")
                    return bart_response
                
                # Format 2: "answer" is an array of objects
                elif 'answer' in body_data and isinstance(body_data['answer'], list):
                    for answer_item in body_data['answer']:
                        # Look for text type answers
                        if 'type' in answer_item and answer_item['type'] == 'text' and 'text' in answer_item:
                            bart_response = answer_item['text']
                            print(f"[BART Answer] {bart_response}")
                            print(f"[BART Timing] Response received in {time.time() - start_time:.2f} seconds")
                            return bart_response
                
                # Format 3: Legacy format with direct "text" field
                elif 'text' in body_data:
                    bart_response = body_data['text']
                    print(f"[BART Answer] {bart_response}")
                    print(f"[BART Timing] Response received in {time.time() - start_time:.2f} seconds")
                    return bart_response
                
                # No recognized format found
                print(f"[BART Warning] Unrecognized response format: {body_data}")
                if 'answer' in body_data:
                    # Try to use any answer field as a fallback
                    answer = str(body_data['answer'])
                    print(f"[BART Answer] (Fallback) {answer}")
                    return answer
                
            except json.JSONDecodeError as e:
                print(f"[BART Error] JSON decode error: {e}")
                # Try to use the body directly if JSON parsing fails
                if isinstance(response_data['body'], str):
                    return response_data['body']
        
        raise Exception("Invalid response format from BART API")
        
    except requests.exceptions.Timeout:
        print("[BART Error] Request timed out")
        return "Sorry, the BART service is taking too long to respond. Please try again."
    except Exception as e:
        print(f"[BART Error] {str(e)}")
        return f"Sorry, there was an error getting information from BART: {str(e)}"

def generate_speech(text):
    try:
        start_time = time.time()
        print(f"[TTS Request] Converting to speech: {text}")
        
        response = openai.audio.speech.create(
            model="tts-1",
            voice="alloy",
            input=text,
            speed=1.2  # Slightly faster speech for reduced latency
        )
        audio_data = response.content
        audio_base64 = base64.b64encode(audio_data).decode('utf-8')
        
        print(f"[TTS Timing] Speech generated in {time.time() - start_time:.2f} seconds")
        return audio_base64
    except Exception as e:
        print(f"[TTS Error] {str(e)}")
        return None

async def process_text_chunk(text):
    """Process a chunk of text in parallel"""
    return await asyncio.get_event_loop().run_in_executor(
        thread_pool, 
        generate_speech, 
        text
    )

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/process', methods=['GET'])
def process_query():
    try:
        start_time = time.time()
        
        # Get query parameters
        user_input = request.args.get('input')
        # Generate unique session ID for each query to prevent context carryover
        session_id = f"session_{int(time.time() * 1000)}"  # Use timestamp for unique ID

        print(f"\n[Query] New request - Input: {user_input}, Session: {session_id}")

        if not user_input:
            return jsonify({'error': 'No query provided'}), 400

        # Prepare query for BART API
        query = {
            "session_id": session_id,
            "input": user_input
        }

        def generate():
            # Get response from BART API
            bart_response = get_bart_response(query)
            
            # Split response into smaller chunks for faster processing
            chunks = []
            current_chunk = ""
            words = bart_response.split()
            
            for word in words:
                current_chunk += word + " "
                # Create chunks of roughly 10-15 words for faster processing
                if len(current_chunk.split()) >= 12 or word.endswith('.') or word.endswith('?') or word.endswith('!'):
                    chunks.append(current_chunk.strip())
                    current_chunk = ""
            
            if current_chunk:
                chunks.append(current_chunk.strip())

            # Process chunks sequentially to maintain order
            for i, chunk in enumerate(chunks):
                print(f"[Processing] Chunk {i+1}/{len(chunks)}: {chunk}")
                
                # Generate speech for this chunk
                audio_base64 = generate_speech(chunk)
                
                if audio_base64:
                    chunk_data = {
                        'text': chunk,
                        'audio': audio_base64,
                        'chunk_index': i,  # Add index to help client maintain order
                        'total_chunks': len(chunks),
                        'is_final': False
                    }
                    yield f"data: {json.dumps(chunk_data)}\n\n"

            total_time = time.time() - start_time
            print(f"[Total Timing] Request completed in {total_time:.2f} seconds")
            
            # Send final chunk
            yield f"data: {json.dumps({'is_final': True})}\n\n"

        return Response(stream_with_context(generate()), mimetype='text/event-stream')

    except Exception as e:
        print(f"[Error] Process query failed: {str(e)}")
        return jsonify({'error': str(e)}), 500

if __name__ == "__main__":
    print("[Server] Starting BART Voice Assistant")
    app.run(debug=True, port=5001)