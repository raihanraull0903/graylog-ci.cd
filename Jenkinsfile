pipeline {
    agent any

    environment {
        IMAGE_NAME = "graylog-alert"
        CONTAINER_NAME = "graylog-alert"
        APP_PORT = "7777"
        CONTAINER_PORT = "3001"
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Build Docker Image') {
            steps {
                sh '''
                    docker build \
                      -t ${IMAGE_NAME}:${BUILD_NUMBER} \
                      -t ${IMAGE_NAME}:latest \
                      .
                '''
            }
        }

        stage('Stop Old Container') {
            steps {
                sh '''
                    docker stop ${CONTAINER_NAME} || true
                    docker rm ${CONTAINER_NAME} || true
                '''
            }
        }

        stage('Run New Container') {
            steps {
                sh '''
                    docker run -d \
                      --name ${CONTAINER_NAME} \
                      --restart unless-stopped \
                      -p ${APP_PORT}:${CONTAINER_PORT} \
                      -e PORT=${CONTAINER_PORT} \
                      ${IMAGE_NAME}:${BUILD_NUMBER}
                '''
            }
        }

        stage('Health Check') {
            steps {
                sh '''
                    echo "Waiting for application..."
                    sleep 5

                    curl -f http://127.0.0.1:${APP_PORT}/health

                    echo ""
                    echo "Deployment successful!"
                '''
            }
        }
    }

    post {
        success {
            echo "======================================"
            echo "Deployment SUCCESS"
            echo "Image: ${IMAGE_NAME}:${BUILD_NUMBER}"
            echo "Container: ${CONTAINER_NAME}"
            echo "URL: http://49.0.3.225:9091"
            echo "======================================"
        }

        failure {
            echo "Deployment FAILED"
        }
    }
}
