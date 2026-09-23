pipeline {
    agent any

    options {
        skipDefaultCheckout(true)
    }

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
                    set -e

                    echo "======================================"
                    echo "BUILD DOCKER IMAGE"
                    echo "======================================"

                    docker build \
                      -t ${IMAGE_NAME}:${BUILD_NUMBER} \
                      -t ${IMAGE_NAME}:latest \
                      .

                    echo ""
                    echo "Docker image berhasil dibuat:"
                    docker images ${IMAGE_NAME}
                '''
            }
        }

        stage('Save Current Version') {
            steps {
                sh '''
                    echo "======================================"
                    echo "SAVE CURRENT VERSION"
                    echo "======================================"

                    if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then

                        PREVIOUS_IMAGE=$(docker inspect \
                          --format='{{.Config.Image}}' \
                          ${CONTAINER_NAME})

                        echo "Previous image: ${PREVIOUS_IMAGE}"

                        echo "${PREVIOUS_IMAGE}" > previous_image.txt

                    else

                        echo "Tidak ada container lama."
                        echo "NONE" > previous_image.txt

                    fi

                    echo ""
                    echo "Saved previous image:"
                    cat previous_image.txt
                '''
            }
        }

        stage('Stop Old Container') {
            steps {
                sh '''
                    echo "======================================"
                    echo "STOP OLD CONTAINER"
                    echo "======================================"

                    docker stop ${CONTAINER_NAME} || true
                    docker rm ${CONTAINER_NAME} || true
                '''
            }
        }

        stage('Deploy New Container') {
            steps {
                sh '''
                    set -e

                    echo "======================================"
                    echo "DEPLOY NEW CONTAINER"
                    echo "======================================"

                    docker run -d \
                      --name ${CONTAINER_NAME} \
                      --restart unless-stopped \
                      -p ${APP_PORT}:${CONTAINER_PORT} \
                      -e PORT=${CONTAINER_PORT} \
                      ${IMAGE_NAME}:${BUILD_NUMBER}

                    echo ""
                    echo "Container baru:"
                    docker ps --filter "name=${CONTAINER_NAME}"
                '''
            }
        }

        stage('Health Check') {
            steps {
                script {

                    def healthResult = sh(
                        script: '''
                            set -e

                            echo "======================================"
                            echo "HEALTH CHECK"
                            echo "======================================"

                            echo "Waiting for application..."
                            sleep 5

                            echo ""
                            echo "Checking /health..."
                            curl -f \
                              --max-time 10 \
                              http://127.0.0.1:${APP_PORT}/health

                            echo ""
                            echo "Checking frontend /..."
                            curl -f \
                              --max-time 10 \
                              http://127.0.0.1:${APP_PORT}/

                            echo ""
                            echo "Health check PASSED!"
                        ''',
                        returnStatus: true
                    )

                    if (healthResult != 0) {

                        echo "======================================"
                        echo "HEALTH CHECK FAILED"
                        echo "STARTING ROLLBACK"
                        echo "======================================"

                        sh '''
                            set +e

                            echo ""
                            echo "===== NEW CONTAINER LOGS ====="

                            docker logs ${CONTAINER_NAME} || true

                            PREVIOUS_IMAGE=$(cat previous_image.txt)

                            echo ""
                            echo "Previous image: ${PREVIOUS_IMAGE}"

                            echo ""
                            echo "Stopping failed container..."

                            docker stop ${CONTAINER_NAME} || true
                            docker rm ${CONTAINER_NAME} || true

                            if [ "${PREVIOUS_IMAGE}" != "NONE" ]; then

                                echo ""
                                echo "======================================"
                                echo "ROLLBACK"
                                echo "======================================"

                                docker run -d \
                                  --name ${CONTAINER_NAME} \
                                  --restart unless-stopped \
                                  -p ${APP_PORT}:${CONTAINER_PORT} \
                                  -e PORT=${CONTAINER_PORT} \
                                  ${PREVIOUS_IMAGE}

                                echo ""
                                echo "Waiting for rollback..."
                                sleep 5

                                echo ""
                                echo "Checking rollback /health..."

                                curl -f \
                                  --max-time 10 \
                                  http://127.0.0.1:${APP_PORT}/health

                                echo ""
                                echo "Checking rollback frontend..."

                                curl -f \
                                  --max-time 10 \
                                  http://127.0.0.1:${APP_PORT}/

                                echo ""
                                echo "======================================"
                                echo "ROLLBACK SUCCESS"
                                echo "======================================"

                            else

                                echo ""
                                echo "Tidak ada previous image."
                                echo "Rollback tidak dapat dilakukan."

                                exit 1

                            fi
                        '''

                        error("Deployment failed. Rollback executed.")

                    } else {

                        echo "======================================"
                        echo "HEALTH CHECK SUCCESS"
                        echo "======================================"
                    }
                }
            }
        }

        stage('Deployment Verification') {
            steps {
                sh '''
                    echo "======================================"
                    echo "DEPLOYMENT VERIFICATION"
                    echo "======================================"

                    echo ""
                    echo "Container:"
                    docker ps --filter "name=${CONTAINER_NAME}"

                    echo ""
                    echo "Application health:"
                    curl -f http://127.0.0.1:${APP_PORT}/health

                    echo ""
                    echo "Frontend:"
                    curl -f http://127.0.0.1:${APP_PORT}/

                    echo ""
                    echo "Deployment successful!"
                '''
            }
        }
    }

    post {

        success {
            echo "======================================"
            echo "DEPLOYMENT SUCCESS"
            echo "======================================"
            echo "Build       : ${BUILD_NUMBER}"
            echo "Image       : ${IMAGE_NAME}:${BUILD_NUMBER}"
            echo "Container   : ${CONTAINER_NAME}"
            echo "Application : http://49.0.3.225:9091"
            echo "======================================"
        }

        failure {
            echo "======================================"
            echo "DEPLOYMENT FAILED"
            echo "======================================"
            echo "Check Jenkins console output."
            echo "======================================"
        }
    }
}
